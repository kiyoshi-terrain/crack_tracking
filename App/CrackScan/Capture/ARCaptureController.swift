import ARKit
import Combine
import Foundation
import UIKit
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

/// 計測に使うフレーム。高解像度が取れなかったときはライブ映像で代用する。
struct MeasurementFrame {
    let frame: ARFrame
    /// false ならライブ映像（1920px 級）。分解能が 2 倍ほど悪い
    let isHighResolution: Bool
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

    /// 計測レティクル（画面の枠）の正規化サイズと中心（**画面**正規化）。ピンチとドラッグで変える
    @Published var reticleSize: CGFloat = 0.5
    @Published var reticleCenter = CGPoint(x: 0.5, y: 0.5)

    /// 高解像度フレームの画素数。HUD の分解能はこれで計算する。
    ///
    /// ライブ映像（1920px 級）の内部パラメータで mm/px を出すと、実際に計測する
    /// 高解像度フレーム（4032px 以上）より 2 倍ほど悪い値が出て、「0.1m まで近づけ」
    /// のような実現不能な助言になる（実機で発生）。セッション開始後に 1 枚だけ
    /// 高解像度フレームを取って画素数を覚え、以後は内部パラメータをその寸法へ拡縮する。
    @Published private(set) var captureResolution: CGSize?
    private var isProbingCaptureResolution = false

    /// 画面（ビューポート）の大きさ。枠を画像座標へ写すのに要る。CaptureView が入れる。
    ///
    /// 画面の正規化座標と画像の正規化座標は**別物**。縦持ちではキャプチャ画像（横長）が
    /// 90° 回って左右を切られて表示されるので、画面中央の正方形は画像上では
    /// 横長の矩形になる。ここを混ぜると、描いた枠と解析した範囲が食い違う。
    var viewportSize: CGSize = .zero

    /// 実際に解析する範囲（**画面**正規化）。枠として描くのはこちら。
    ///
    /// 枠を画像へ写し、解析できる画素数の上限で中心から縮めた結果を画面へ戻したもの。
    /// 黙って中央だけ切ると「枠に入れたのに検出されない」が起きる。
    @Published private(set) var analysisRegionOnScreen: CGRect?
    /// 解析範囲の実寸（mm）。枠の下に出す
    @Published private(set) var analysisRegionSizeMM: CGSize?

    /// カメラの動き（°/s）。手ブレ判定と、計測前の静止待ちに使う
    @Published private(set) var motionDegPerSec: Double = 0
    /// 計測のために静止を待っている
    @Published private(set) var isWaitingForStillness = false

    let session = ARSession()

    var evaluator = CaptureQualityEvaluator()

    /// 撮影データの保存先
    private(set) var sessionDirectory: URL?

    /// 直近のライブ推定。高解像度フレームに深度が付いてこないときの代わりに使う
    /// （0.2 秒以内のフレームなら、手持ちでも姿勢差は mm 級で LiDAR の誤差より小さい）
    private var latestEstimate: (estimate: DepthPlaneEstimator.Estimate, at: Date)?
    /// ライブ映像の画素数（ブレ指標を同じ尺度で出すため）
    private var liveResolution: CGSize?
    private var lastMotionSample: (transform: simd_float4x4, timestamp: TimeInterval)?

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
        captureResolution = nil
        isProbingCaptureResolution = false
        latestEstimate = nil
        lastMotionSample = nil
        motionDegPerSec = 0
        analysisRegionOnScreen = nil
        analysisRegionSizeMM = nil

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

    // MARK: - 撮影（記録用フレームの保存）

    /// 高解像度フレームを1枚保存する（写真測量・再解析の元データ）。
    func capture() {
        guard sessionDirectory != nil else {
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
                let region = self.analysisRegion(for: frame)
                guard let estimate = DepthPlaneEstimator.estimate(frame: frame, normalizedRegion: region) ?? self.recentEstimate else {
                    self.errorMessage = "壁面までの距離を取得できませんでした。もう少し近づいてゆっくり動かしてください"
                    return
                }
                _ = self.save(frame: frame, estimate: estimate)
            }
        }
    }

    /// 計測に使った静止画を記録として保存する（計測値の証拠写真になる）。
    @discardableResult
    func saveStill(_ still: MeasurementStill) -> CapturedFrame? {
        save(frame: still.frame, estimate: still.estimate)
    }

    private func save(frame: ARFrame, estimate: DepthPlaneEstimator.Estimate) -> CapturedFrame? {
        guard let directory = sessionDirectory else {
            errorMessage = "保存先が設定されていません"
            return nil
        }
        guard let conditions = makeConditions(frame: frame, estimate: estimate) else { return nil }

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
            return captured
        } catch {
            errorMessage = "保存に失敗しました: \(error.localizedDescription)"
            return nil
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

    // MARK: - 計測用の静止画

    /// 計測用のフレームを1枚取得する（保存はしない）。
    ///
    /// 幅の計測精度は分解能で決まるので、まず高解像度フレームを取り直す。
    /// 取れなかったとき（連続呼び出し・非対応）はライブ映像で代用し、その旨を返す。
    /// 黙って「取得できませんでした」で止めるより、参考値でも出して注記する方が現場では役に立つ。
    func measurementFrame() async -> MeasurementFrame? {
        let hiRes: ARFrame? = await withCheckedContinuation { (continuation: CheckedContinuation<ARFrame?, Never>) in
            session.captureHighResolutionFrame { frame, _ in
                continuation.resume(returning: frame)
            }
        }
        if let hiRes { return MeasurementFrame(frame: hiRes, isHighResolution: true) }
        if let live = session.currentFrame { return MeasurementFrame(frame: live, isHighResolution: false) }
        return nil
    }

    /// 直近 1 秒以内のライブ推定（高解像度フレームに深度が無いときの代わり）。
    var recentEstimate: DepthPlaneEstimator.Estimate? {
        guard let latest = latestEstimate, Date().timeIntervalSince(latest.at) < 1.0 else { return nil }
        return latest.estimate
    }

    /// 計測用の静止画を撮る。
    ///
    /// 手持ちで動いている間に撮ると断面がボケて幅が太く出るので、動きが収まるのを
    /// 最大 1.5 秒待ってから撮る。撮った画像のブレも同じ尺度で測って結果に添える。
    func captureStill() async -> MeasurementStill? {
        isWaitingForStillness = true
        let deadline = Date().addingTimeInterval(1.5)
        while motionDegPerSec > evaluator.thresholds.stillnessDegPerSec, Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        isWaitingForStillness = false

        guard let captured = await measurementFrame() else {
            errorMessage = "フレームを取得できませんでした。カメラが動いているか確認してください"
            return nil
        }
        let frame = captured.frame
        let region = analysisRegion(for: frame)

        var usedFallback = false
        var estimate = DepthPlaneEstimator.estimate(frame: frame, normalizedRegion: region)
        if estimate == nil, let recent = recentEstimate {
            estimate = recent
            usedFallback = true
        }
        guard let estimate else {
            errorMessage = "壁面までの距離を取得できませんでした。LiDAR の届く距離（〜3m）まで近づいて、少し待ってからもう一度押してください"
            return nil
        }

        let size = frame.capturedImageSize
        let intrinsics = DepthPlaneEstimator.cameraIntrinsics(frame: frame)
        let scale = SurfaceScale(intrinsics: intrinsics, plane: estimate.plane)
        let center = Vec2(region.midX * size.width, region.midY * size.height)
        let mmPerPx = scale.nominalMillimetersPerPixel(at: center) ?? 0
        let distance = scale.distance(at: center) ?? estimate.centerDistance

        let focus = stillFocusScore(frame: frame, region: region)
        let turns = ImageConversion.quarterTurnsClockwise(for: ARDisplayMapping.currentOrientation)
        guard let display = ImageConversion.cgImage(from: frame.capturedImage, quarterTurnsClockwise: turns) else {
            errorMessage = "画像を表示用に変換できませんでした"
            return nil
        }

        return MeasurementStill(
            frame: frame,
            isHighResolution: captured.isHighResolution,
            estimate: estimate,
            usedFallbackEstimate: usedFallback,
            analysisRegion: region,
            display: display,
            mapping: RotatedImageMapping(rawWidth: Int(size.width), rawHeight: Int(size.height), quarterTurnsClockwise: turns),
            focusScore: focus,
            isSharp: focus >= evaluator.thresholds.minFocusScore,
            millimetersPerPixel: mmPerPx,
            distance: distance,
            capturedAt: Date()
        )
    }

    /// 静止画のブレ指標。ライブ判定と同じ尺度で出すため、ライブ映像の画素密度まで縮小してから測る。
    private func stillFocusScore(frame: ARFrame, region: CGRect) -> Double {
        let size = frame.capturedImageSize
        let live = liveResolution ?? size
        guard live.width > 0 else { return 0 }
        let ratio = max(1, Int((size.width / live.width).rounded()))
        let side = Int(min(live.width, live.height)) / 6 * ratio
        let probe = PixelRect(
            x: Int(region.midX * size.width) - side / 2,
            y: Int(region.midY * size.height) - side / 2,
            width: side,
            height: side
        ).clamped(toWidth: Int(size.width), height: Int(size.height))
        guard probe.width > 8, probe.height > 8,
              let gray = ImageConversion.grayImage(from: frame.capturedImage, region: probe, linearize: false) else { return 0 }
        return ImageFilters.varianceOfLaplacian(ratio > 1 ? gray.downsampled(by: ratio) : gray)
    }

    // MARK: - 解析範囲

    /// レティクル（計測枠）の**画面**正規化矩形。画面の中に収まるようにクランプする。
    func reticleRegion() -> CGRect {
        let size = max(0.1, min(0.9, reticleSize))
        let cx = min(max(reticleCenter.x, size / 2), 1 - size / 2)
        let cy = min(max(reticleCenter.y, size / 2), 1 - size / 2)
        return CGRect(x: cx - size / 2, y: cy - size / 2, width: size, height: size)
    }

    /// 枠を動かした直後に、描く枠を最新のフレームで作り直す（次の評価を待たない）。
    func refreshAnalysisRegionOnScreen() {
        guard let frame = session.currentFrame else { return }
        let region = analysisRegion(for: frame)
        analysisRegionOnScreen = screenNormalizedRect(imageRect: region, frame: frame)
        updateRegionSize(region: region, frame: frame)
    }

    private func updateRegionSize(region: CGRect, frame: ARFrame) {
        guard let c = conditions else {
            analysisRegionSizeMM = nil
            return
        }
        let size = captureResolution ?? frame.capturedImageSize
        analysisRegionSizeMM = CGSize(
            width: region.width * size.width * c.millimetersPerPixel,
            height: region.height * size.height * c.millimetersPerPixel
        )
    }

    /// 検出の縮小率。直近の分解能と目標幅から（`AnalysisPlanner`）。
    func detectionFactor() -> Int {
        guard let c = conditions else { return 1 }
        let targetPx = AnalysisPlanner.targetWidthPx(
            targetWidthMM: evaluator.thresholds.targetCrackWidthMM,
            millimetersPerPixel: c.millimetersPerPixel
        )
        return AnalysisPlanner.detectionFactor(targetWidthPx: targetPx)
    }

    /// 実際に解析する範囲（**画像**正規化）。
    ///
    /// 枠を画像座標へ写し、解析できる画素数の上限（縮小率 × 検出画像の上限）で
    /// 中心から縮める。デプスの平面フィットも、計測の切り出しも、この矩形を使う。
    func analysisRegion(for frame: ARFrame) -> CGRect {
        let base = imageNormalizedRect(screenRect: reticleRegion(), frame: frame)
        let size = captureResolution ?? frame.capturedImageSize
        guard size.width > 0, size.height > 0 else { return base }
        let px = PixelRect(
            x: Int(base.minX * size.width),
            y: Int(base.minY * size.height),
            width: Int(base.width * size.width),
            height: Int(base.height * size.height)
        )
        let maxSide = AnalysisPlanner.maxAnalysisSide(factor: detectionFactor())
        let clamped = AnalysisPlanner.clampRegion(px, maxSide: maxSide)
        return CGRect(
            x: CGFloat(clamped.x) / size.width,
            y: CGFloat(clamped.y) / size.height,
            width: CGFloat(clamped.width) / size.width,
            height: CGFloat(clamped.height) / size.height
        )
    }

    /// 画面正規化の矩形を、このフレームの画像正規化座標へ写す。
    private func imageNormalizedRect(screenRect: CGRect, frame: ARFrame) -> CGRect {
        guard viewportSize.width > 0, viewportSize.height > 0 else { return screenRect }
        let inverse = frame
            .displayTransform(for: ARDisplayMapping.currentOrientation, viewportSize: viewportSize)
            .inverted()
        let mapped = Self.boundingBox(of: screenRect, applying: inverse)
            .intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        return mapped.isNull || mapped.isEmpty ? screenRect : mapped
    }

    /// 画像正規化の矩形を画面正規化へ写す（描画用）。
    private func screenNormalizedRect(imageRect: CGRect, frame: ARFrame) -> CGRect? {
        guard viewportSize.width > 0, viewportSize.height > 0 else { return nil }
        let transform = frame.displayTransform(for: ARDisplayMapping.currentOrientation, viewportSize: viewportSize)
        return Self.boundingBox(of: imageRect, applying: transform)
    }

    /// 矩形の四隅を写した外接矩形。90° 回転なら矩形は矩形に写るので厳密。
    private static func boundingBox(of rect: CGRect, applying transform: CGAffineTransform) -> CGRect {
        let corners = [
            CGPoint(x: rect.minX, y: rect.minY),
            CGPoint(x: rect.maxX, y: rect.minY),
            CGPoint(x: rect.minX, y: rect.maxY),
            CGPoint(x: rect.maxX, y: rect.maxY),
        ].map { $0.applying(transform) }
        let xs = corners.map(\.x)
        let ys = corners.map(\.y)
        guard let x0 = xs.min(), let x1 = xs.max(), let y0 = ys.min(), let y1 = ys.max() else { return rect }
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    // MARK: - リアルタイム評価

    private func evaluate(frame: ARFrame) {
        liveResolution = frame.capturedImageSize
        let region = analysisRegion(for: frame)
        analysisRegionOnScreen = screenNormalizedRect(imageRect: region, frame: frame)

        guard let estimate = DepthPlaneEstimator.estimate(
            frame: frame,
            normalizedRegion: region,
            maxSamplesPerAxis: 24
        ) else {
            conditions = nil
            verdict = nil
            analysisRegionSizeMM = nil
            return
        }
        latestEstimate = (estimate, Date())
        updateMotion(frame: frame, distance: estimate.centerDistance)
        probeCaptureResolutionIfNeeded(frame: frame)
        guard let c = makeConditions(frame: frame, estimate: estimate) else { return }
        conditions = c
        verdict = evaluator.evaluate(c)
        updateRegionSize(region: region, frame: frame)
    }

    /// カメラの動きを °/s で出す。回転と、距離で割った並進（像の動きとしては同じ）の大きい方。
    private func updateMotion(frame: ARFrame, distance: Double) {
        let transform = frame.camera.transform
        defer { lastMotionSample = (transform, frame.timestamp) }
        guard let last = lastMotionSample else { return }
        let dt = frame.timestamp - last.timestamp
        guard dt > 0.02 else { return }

        let q0 = simd_quatf(last.transform)
        let q1 = simd_quatf(transform)
        var angle = Double((q1 * q0.inverse).angle)
        if angle > .pi { angle = 2 * .pi - angle }

        let p0 = simd_make_float3(last.transform.columns.3)
        let p1 = simd_make_float3(transform.columns.3)
        let translation = Double(simd_length(p1 - p0))
        let equivalent = translation / max(distance, 0.1)

        motionDegPerSec = max(angle, equivalent) / dt * 180 / .pi
    }

    /// 高解像度フレームの画素数を 1 回だけ調べる（保存はしない）。
    private func probeCaptureResolutionIfNeeded(frame: ARFrame) {
        guard captureResolution == nil, !isProbingCaptureResolution else { return }
        guard case .normal = frame.camera.trackingState else { return }
        isProbingCaptureResolution = true
        session.captureHighResolutionFrame { [weak self] hiRes, _ in
            Task { @MainActor in
                guard let self else { return }
                self.isProbingCaptureResolution = false
                // 実際の画素バッファの寸法で持つ（camera.imageResolution と食い違う可能性に備える）
                if let hiRes { self.captureResolution = hiRes.capturedImageSize }
            }
        }
    }

    private func makeConditions(
        frame: ARFrame,
        estimate: DepthPlaneEstimator.Estimate
    ) -> CaptureConditions? {
        // ライブ映像の内部パラメータ。ピント・露出の評価（ライブ画像を切り出す）はこちら
        let intrinsics = DepthPlaneEstimator.cameraIntrinsics(frame: frame)
        // 分解能・入射角は、実際に計測する高解像度フレームの寸法で出す。
        // 画素数が分かるまで（開始直後の 1 秒ほど）はライブ映像の値で、HUD には「仮」と出る
        let scaleIntrinsics = captureResolution.map {
            intrinsics.scaled(toWidth: Int($0.width), height: Int($0.height))
        } ?? intrinsics
        let scale = SurfaceScale(intrinsics: scaleIntrinsics, plane: estimate.plane)
        let center = Vec2(Double(scaleIntrinsics.imageWidth) / 2, Double(scaleIntrinsics.imageHeight) / 2)

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
            isTrackingStable: stable,
            angularSpeedDegPerSec: motionDegPerSec
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
