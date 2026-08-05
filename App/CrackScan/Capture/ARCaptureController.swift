import ARKit
import Combine
import Foundation
import CrackCore

/// 保存された1フレーム分の撮影データ。
struct CapturedFrame: Identifiable {
    let id = UUID()
    let index: Int
    let capturedAt: Date
    let intrinsics: CameraIntrinsics
    let plane: Plane
    let cameraTransform: simd_float4x4
    let conditions: CaptureConditions
    /// 保存した画像ファイル（HEIC）の URL
    let imageURL: URL
    /// デプス（Float32 TIFF）の URL。写真測量の外部処理で使う。
    let depthURL: URL?
}

/// AR セッションの管理・撮影品質のリアルタイム評価・フレーム保存。
@MainActor
final class ARCaptureController: NSObject, ObservableObject {

    // MARK: - 公開状態

    @Published private(set) var verdict: CaptureVerdict?
    @Published private(set) var conditions: CaptureConditions?
    @Published private(set) var capturedFrames: [CapturedFrame] = []
    @Published private(set) var isSaving = false
    @Published private(set) var trackingStateMessage: String?
    @Published private(set) var coverageRatio: Double = 0
    @Published var errorMessage: String?

    /// 計測レティクル（画面中央の枠）の正規化サイズ
    @Published var reticleSize: CGFloat = 0.5

    let session = ARSession()

    var evaluator = CaptureQualityEvaluator()

    /// 撮影データの保存先
    private(set) var sessionDirectory: URL?

    private var lastEvaluation = Date.distantPast
    private let evaluationInterval: TimeInterval = 0.2
    private var frameCounter = 0
    private var coverage: CoverageTracker?
    private let writer = FrameBundleWriter()

    // MARK: - ライフサイクル

    override init() {
        super.init()
        session.delegate = self
    }

    /// 指定ディレクトリに保存する撮影セッションを開始する。
    func start(sessionDirectory directory: URL, targetCrackWidthMM: Double) {
        self.sessionDirectory = directory
        evaluator.thresholds.targetCrackWidthMM = targetCrackWidthMM
        frameCounter = 0
        capturedFrames = []
        coverage = CoverageTracker(areaWidth: 4.0, areaHeight: 3.0, cellSize: 0.1)
        coverageRatio = 0

        let configuration = ARWorldTrackingConfiguration()
        configuration.worldAlignment = .gravity
        configuration.environmentTexturing = .none
        configuration.isAutoFocusEnabled = true

        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            configuration.frameSemantics.insert(.smoothedSceneDepth)
        } else if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
            configuration.frameSemantics.insert(.sceneDepth)
        } else {
            errorMessage = "この端末には LiDAR がありません。実寸計測には LiDAR 搭載機（iPhone 12 Pro 以降の Pro / Pro Max）が必要です。"
        }

        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) {
            configuration.sceneReconstruction = .mesh
        }

        // 高解像度の静止画キャプチャに対応した映像フォーマットを選ぶ。
        // ひび割れ幅は分解能で決まるので、ここは最大解像度を取りにいく。
        if let format = ARWorldTrackingConfiguration.recommendedVideoFormatForHighResolutionFrameCapturing {
            configuration.videoFormat = format
        }

        session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
    }

    func pause() {
        session.pause()
    }

    // MARK: - 撮影

    /// 高解像度フレームを1枚保存する。
    func capture() {
        guard let directory = sessionDirectory else {
            errorMessage = "保存先が設定されていません"
            return
        }
        guard verdict?.canCapture ?? false else {
            errorMessage = verdict?.primaryMessage ?? "撮影条件を満たしていません"
            return
        }
        guard !isSaving else { return }
        isSaving = true

        session.captureHighResolutionFrame { [weak self] frame, error in
            guard let self else { return }
            Task { @MainActor in
                defer { self.isSaving = false }
                if let error {
                    self.errorMessage = "撮影に失敗しました: \(error.localizedDescription)"
                    return
                }
                guard let frame else { return }
                self.save(frame: frame, into: directory)
            }
        }
    }

    /// 計測用に高解像度フレームを1枚取得する（保存はしない）。
    ///
    /// 幅の計測精度は分解能で決まるので、プレビュー解像度ではなく
    /// 必ず高解像度フレームを取り直します。
    func highResolutionFrame() async -> ARFrame? {
        await withCheckedContinuation { (continuation: CheckedContinuation<ARFrame?, Never>) in
            session.captureHighResolutionFrame { frame, _ in
                continuation.resume(returning: frame)
            }
        }
    }

    private func save(frame: ARFrame, into directory: URL) {
        let region = reticleRegion()
        guard let estimate = DepthPlaneEstimator.estimate(frame: frame, normalizedRegion: region) else {
            errorMessage = "壁面までの距離を取得できませんでした。もう少し近づいてゆっくり動かしてください"
            return
        }
        guard let conditions = makeConditions(frame: frame, estimate: estimate) else { return }

        let index = frameCounter
        frameCounter += 1

        do {
            let bundle = try writer.write(frame: frame, index: index, into: directory)
            let captured = CapturedFrame(
                index: index,
                capturedAt: Date(),
                intrinsics: DepthPlaneEstimator.cameraIntrinsics(frame: frame),
                plane: estimate.plane,
                cameraTransform: frame.camera.transform,
                conditions: conditions,
                imageURL: bundle.imageURL,
                depthURL: bundle.depthURL
            )
            capturedFrames.append(captured)
            recordCoverage(for: captured)
        } catch {
            errorMessage = "保存に失敗しました: \(error.localizedDescription)"
        }
    }

    private func recordCoverage(for frame: CapturedFrame) {
        guard var tracker = coverage else { return }
        let scale = SurfaceScale(intrinsics: frame.intrinsics, plane: frame.plane)
        let center = Vec2(Double(frame.intrinsics.imageWidth) / 2, Double(frame.intrinsics.imageHeight) / 2)
        guard let mmPerPx = scale.nominalMillimetersPerPixel(at: center) else { return }
        let width = Double(frame.intrinsics.imageWidth) * mmPerPx / 1000
        let height = Double(frame.intrinsics.imageHeight) * mmPerPx / 1000

        // カメラ位置をそのまま壁面座標に見立てた簡易カバレッジ。
        // 厳密な壁面座標系は後段の写真測量で確定する。
        let t = frame.cameraTransform.columns.3
        let origin = Vec2(Double(t.x) + 2.0 - width / 2, Double(t.y) + 1.5 - height / 2)
        tracker.record(footprintOrigin: origin, width: width, height: height)
        coverage = tracker
        coverageRatio = tracker.coverageRatio
    }

    // MARK: - リアルタイム評価

    /// レティクル（画面中央の計測枠）に対応する正規化矩形。
    func reticleRegion() -> CGRect {
        let size = max(0.1, min(0.9, reticleSize))
        return CGRect(x: (1 - size) / 2, y: (1 - size) / 2, width: size, height: size)
    }

    private func evaluate(frame: ARFrame) {
        guard let estimate = DepthPlaneEstimator.estimate(
            frame: frame,
            normalizedRegion: reticleRegion(),
            maxSamplesPerAxis: 24
        ) else {
            conditions = nil
            verdict = nil
            return
        }
        guard let c = makeConditions(frame: frame, estimate: estimate) else { return }
        conditions = c
        verdict = evaluator.evaluate(c)
    }

    private func makeConditions(
        frame: ARFrame,
        estimate: DepthPlaneEstimator.Estimate
    ) -> CaptureConditions? {
        let intrinsics = DepthPlaneEstimator.cameraIntrinsics(frame: frame)
        let scale = SurfaceScale(intrinsics: intrinsics, plane: estimate.plane)
        let center = Vec2(Double(intrinsics.imageWidth) / 2, Double(intrinsics.imageHeight) / 2)

        guard let mmPerPx = scale.nominalMillimetersPerPixel(at: center),
              let angle = scale.incidenceAngleDegrees(at: center) else { return nil }

        // ピント・露出はレティクル中心の小領域だけで評価する（全画面は重い）
        let side = min(intrinsics.imageWidth, intrinsics.imageHeight) / 6
        let probeRegion = PixelRect(
            x: intrinsics.imageWidth / 2 - side / 2,
            y: intrinsics.imageHeight / 2 - side / 2,
            width: side,
            height: side
        )
        guard let probe = ImageConversion.grayImage(
            from: frame.capturedImage,
            region: probeRegion,
            linearize: false
        ) else { return nil }

        let stable: Bool
        switch frame.camera.trackingState {
        case .normal: stable = true
        default: stable = false
        }

        return CaptureConditions(
            distance: estimate.centerDistance,
            incidenceAngleDegrees: angle,
            millimetersPerPixel: mmPerPx,
            focusScore: ImageFilters.varianceOfLaplacian(probe),
            meanLuminance: Double(probe.mean),
            saturatedRatio: ImageConversion.saturatedRatio(probe),
            planeResidual: estimate.rmsResidual,
            isTrackingStable: stable
        )
    }
}

// MARK: - ARSessionDelegate

extension ARCaptureController: ARSessionDelegate {

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        Task { @MainActor in
            let now = Date()
            guard now.timeIntervalSince(self.lastEvaluation) >= self.evaluationInterval else { return }
            self.lastEvaluation = now
            self.evaluate(frame: frame)
        }
    }

    nonisolated func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let message: String?
        switch camera.trackingState {
        case .normal:
            message = nil
        case .notAvailable:
            message = "トラッキング初期化中…"
        case .limited(let reason):
            switch reason {
            case .initializing: message = "初期化中。端末をゆっくり動かしてください"
            case .excessiveMotion: message = "動きが速すぎます"
            case .insufficientFeatures: message = "特徴が少ない面です。ライト点灯や範囲拡大を試してください"
            case .relocalizing: message = "位置を再取得中…"
            @unknown default: message = "トラッキングが不安定です"
            }
        }
        Task { @MainActor in
            self.trackingStateMessage = message
        }
    }

    nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
        Task { @MainActor in
            self.errorMessage = "AR セッションのエラー: \(error.localizedDescription)"
        }
    }
}
