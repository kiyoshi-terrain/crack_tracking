import ARKit
import SwiftUI
import CrackCore

/// 撮影・計測のメイン画面（ライブ映像）。
///
/// 計測は「撮る → 静止画の上でなぞる」の 2 段。ここは撮るところまでで、
/// 撮った静止画は `StillReviewView` に渡す。
///
/// `ARCaptureController` / `MeasureViewModel` はどちらも `@MainActor` なので、
/// 画面側も MainActor に固定して `Task {}` が正しくホップするようにしている。
@MainActor
struct CaptureView: View {
    @Binding var project: InspectionProject
    let memberName: String

    @EnvironmentObject private var store: ProjectStore
    @Environment(\.dismiss) private var dismiss

    @StateObject private var controller = ARCaptureController()
    @StateObject private var measurer = MeasureViewModel()

    @State private var session = CaptureSession()
    @State private var isReviewing = false
    @State private var isCapturing = false
    @State private var reticleSizeAtGestureStart: CGFloat?
    @State private var reticleCenterAtGestureStart: CGPoint?

    var body: some View {
        ZStack {
            ARViewContainer(session: controller.session)
                .ignoresSafeArea()

            GeometryReader { geometry in
                ZStack {
                    // 枠はピンチで大きさ、ドラッグで位置を変える
                    Color.clear
                        .contentShape(Rectangle())
                        .gesture(reticleGestures(viewport: geometry.size))
                    reticle(in: geometry.size)
                }
                // 枠を画像座標へ写すのに画面の大きさが要る（画面と画像の正規化座標は別物）
                .onAppear { controller.viewportSize = geometry.size }
                .onChange(of: geometry.size) { _, size in controller.viewportSize = size }
            }
            .ignoresSafeArea()

            VStack {
                CaptureHUD(
                    verdict: controller.verdict,
                    conditions: controller.conditions,
                    trackingMessage: controller.trackingStateMessage,
                    frameCount: controller.capturedFrames.count,
                    coverageRatio: controller.coverageRatio,
                    targetWidthMM: project.targetCrackWidthMM,
                    captureResolution: controller.captureResolution
                )
                Spacer()
                controls
            }
            .padding()

            if isCapturing {
                busyOverlay(controller.isWaitingForStillness ? "静止してください…" : "撮影中…")
            }
        }
        .statusBarHidden()
        .onAppear(perform: startSession)
        .onDisappear { controller.pause() }
        .fullScreenCover(isPresented: $isReviewing) {
            StillReviewView(
                measurer: measurer,
                project: project,
                onRecord: { recordFromStill() },
                onRetake: {
                    isReviewing = false
                    measurer.clear()
                },
                onCalibrate: { calibration in
                    // 幅校正は端末・レンズの性質なので案件に残す（次の撮影から効く）
                    project.widthCalibration = calibration
                    store.save(project)
                }
            )
        }
        .alert("エラー", isPresented: Binding(
            get: { controller.errorMessage != nil },
            set: { if !$0 { controller.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { controller.errorMessage = nil }
        } message: {
            Text(controller.errorMessage ?? "")
        }
    }

    // MARK: - パーツ

    /// 計測枠。**実際に解析する範囲**を描く（設定上の枠ではなく）。
    private func reticle(in size: CGSize) -> some View {
        let region = controller.analysisRegionOnScreen ?? controller.reticleRegion()
        let rect = CGRect(
            x: region.minX * size.width,
            y: region.minY * size.height,
            width: region.width * size.width,
            height: region.height * size.height
        )
        let color: Color = {
            guard let level = controller.verdict?.level else { return .white.opacity(0.5) }
            switch level {
            case .good: return .green
            case .warning: return .yellow
            case .blocking: return .red
            }
        }()

        return ZStack {
            RoundedRectangle(cornerRadius: 8)
                .stroke(color, lineWidth: 2)
                .frame(width: rect.width, height: rect.height)
                .position(x: rect.midX, y: rect.midY)
                .animation(.easeOut(duration: 0.2), value: controller.verdict?.level)

            if let mm = controller.analysisRegionSizeMM {
                Text(String(format: "解析範囲 %.0f × %.0f mm", mm.width, mm.height))
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.black.opacity(0.45), in: Capsule())
                    .foregroundStyle(.white)
                    .position(x: rect.midX, y: min(size.height - 12, rect.maxY + 16))
            }
        }
        .allowsHitTesting(false)
    }

    /// ピンチで枠の大きさ、ドラッグで枠の位置。
    private func reticleGestures(viewport: CGSize) -> some Gesture {
        let magnify = MagnifyGesture()
            .onChanged { value in
                if reticleSizeAtGestureStart == nil {
                    reticleSizeAtGestureStart = controller.reticleSize
                }
                let start = reticleSizeAtGestureStart ?? controller.reticleSize
                controller.reticleSize = min(0.9, max(0.1, start * value.magnification))
                controller.refreshAnalysisRegionOnScreen()
            }
            .onEnded { _ in reticleSizeAtGestureStart = nil }

        let drag = DragGesture(minimumDistance: 8)
            .onChanged { value in
                if reticleCenterAtGestureStart == nil {
                    reticleCenterAtGestureStart = controller.reticleCenter
                }
                let start = reticleCenterAtGestureStart ?? controller.reticleCenter
                guard viewport.width > 0, viewport.height > 0 else { return }
                controller.reticleCenter = CGPoint(
                    x: start.x + value.translation.width / viewport.width,
                    y: start.y + value.translation.height / viewport.height
                )
                controller.refreshAnalysisRegionOnScreen()
            }
            .onEnded { _ in reticleCenterAtGestureStart = nil }

        return magnify.simultaneously(with: drag)
    }

    private var controls: some View {
        VStack(spacing: 6) {
            Text("枠はピンチで大きさ、ドラッグで位置。計測を押すと静止画を撮り、その上で亀裂をなぞります")
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.85))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 8)

            HStack(spacing: 20) {
                Button {
                    finish()
                } label: {
                    Label("完了", systemImage: "checkmark")
                        .frame(width: 74, height: 46)
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await captureAndReview() }
                } label: {
                    VStack(spacing: 2) {
                        Image(systemName: "ruler")
                            .font(.title2)
                        Text("計測")
                            .font(.caption2)
                    }
                    .frame(width: 78, height: 78)
                    .background(Circle().fill(Color.accentColor))
                    .foregroundStyle(.white)
                }
                .disabled(isCapturing)

                Button {
                    controller.capture()
                } label: {
                    VStack(spacing: 2) {
                        Image(systemName: "camera.fill")
                            .font(.title3)
                        Text("記録")
                            .font(.caption2)
                    }
                    .frame(width: 74, height: 46)
                }
                .buttonStyle(.bordered)
                .disabled(controller.isSaving)
            }
        }
        .padding(.bottom, 8)
    }

    private func busyOverlay(_ message: String) -> some View {
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea()
            VStack(spacing: 12) {
                ProgressView()
                    .controlSize(.large)
                Text(message)
                    .font(.footnote)
            }
            .padding(24)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }

    // MARK: - 動作

    private func startSession() {
        session = CaptureSession(memberName: memberName)
        do {
            let directory = try store.prepareSessionDirectory(session: session, in: project)
            controller.start(sessionDirectory: directory, targetCrackWidthMM: project.targetCrackWidthMM)
        } catch {
            controller.errorMessage = "保存先を用意できませんでした: \(error.localizedDescription)"
        }
    }

    /// 静止画を撮って、なぞる画面へ。
    private func captureAndReview() async {
        guard !isCapturing else { return }
        isCapturing = true
        defer { isCapturing = false }
        measurer.clear()
        measurer.useCalibration(project.widthCalibration)
        guard let still = await controller.captureStill() else { return }
        measurer.begin(still: still)
        isReviewing = true
    }

    /// なぞる画面で選んだひび割れを記録する。計測に使った静止画も証拠として保存する。
    private func recordFromStill() {
        guard let still = measurer.still else { return }
        let saved = controller.saveStill(still)
        let photo = saved.flatMap { relativePath(of: $0.imageURL) }
        let records = measurer.makeRecords(
            startingLabelNumber: nextLabelNumber(),
            photoRelativePath: photo
        )
        guard !records.isEmpty else { return }

        session.cracks.append(contentsOf: records)
        session.frameCount = controller.capturedFrames.count
        session.coverageRatio = controller.coverageRatio
        upsertSession()
        isReviewing = false
        measurer.clear()
    }

    private func finish() {
        session.frameCount = controller.capturedFrames.count
        session.coverageRatio = controller.coverageRatio
        if !session.cracks.isEmpty || session.frameCount > 0 {
            upsertSession()
        }
        controller.pause()
        dismiss()
    }

    private func upsertSession() {
        if let index = project.sessions.firstIndex(where: { $0.id == session.id }) {
            project.sessions[index] = session
        } else {
            project.sessions.append(session)
        }
        store.save(project)
    }

    private func nextLabelNumber() -> Int {
        var merged = project
        if let index = merged.sessions.firstIndex(where: { $0.id == session.id }) {
            merged.sessions[index] = session
        } else {
            merged.sessions.append(session)
        }
        let existing = merged.allCracks.compactMap { crack -> Int? in
            guard crack.label.hasPrefix("C-") else { return nil }
            return Int(crack.label.dropFirst(2))
        }
        return (existing.max() ?? 0) + 1
    }

    /// 保存した写真の、案件フォルダからの相対パス。
    private func relativePath(of url: URL) -> String? {
        let projectDirectory = store.directory(for: project).path
        let path = url.path
        guard path.hasPrefix(projectDirectory) else { return nil }
        return String(path.dropFirst(projectDirectory.count).drop(while: { $0 == "/" }))
    }
}
