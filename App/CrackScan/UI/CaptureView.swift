import ARKit
import SwiftUI
import CrackCore

/// 撮影・計測のメイン画面。
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

    /// 画面上の指の大きさ（pt）。タップ位置から芯線を探す半径をこれから画像 px に換算する
    private let tapToleranceInPoints: CGFloat = 28

    var body: some View {
        ZStack {
            ARViewContainer(session: controller.session)
                .ignoresSafeArea()

            GeometryReader { geometry in
                ZStack {
                    // 結果が出ていないときは、タップした1本だけを測るモード。
                    // 「枠内を全部測る」と使い分けられるようにしている。
                    if !measurer.hasResults {
                        Color.clear
                            .contentShape(Rectangle())
                            .onTapGesture { location in
                                Task { await measureTapped(at: location, viewport: geometry.size) }
                            }
                    }
                    reticle(in: geometry.size)
                    CrackOverlay(
                        candidates: measurer.candidates,
                        imageSize: measurer.sourceImageSize,
                        frame: measurer.referenceFrame,
                        viewport: geometry.size,
                        thresholds: project.gradeThresholds,
                        onTap: { measurer.toggle($0) }
                    )
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
                if measurer.hasResults {
                    resultPanel
                }
                controls
            }
            .padding()

            if measurer.isRunning {
                busyOverlay
            }
        }
        .statusBarHidden()
        .onAppear(perform: startSession)
        .onDisappear { controller.pause() }
        .alert("エラー", isPresented: Binding(
            get: { controller.errorMessage != nil || measurer.errorMessage != nil },
            set: { if !$0 { controller.errorMessage = nil; measurer.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {
                controller.errorMessage = nil
                measurer.errorMessage = nil
            }
        } message: {
            Text(controller.errorMessage ?? measurer.errorMessage ?? "")
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

        return RoundedRectangle(cornerRadius: 8)
            .stroke(color, lineWidth: 2)
            .frame(width: rect.width, height: rect.height)
            .position(x: rect.midX, y: rect.midY)
            .animation(.easeOut(duration: 0.2), value: controller.verdict?.level)
    }

    private var resultPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("検出 \(measurer.candidates.count) 本／選択 \(measurer.selectedCount) 本")
                    .font(.footnote.weight(.semibold))
                Spacer()
                Button("クリア") { measurer.clear() }
                    .font(.footnote)
            }
            if let notice = measurer.notice {
                Label(notice, systemImage: "info.circle")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(measurer.candidates) { candidate in
                        CandidateChip(
                            candidate: candidate,
                            thresholds: project.gradeThresholds
                        ) {
                            measurer.toggle(candidate.id)
                        }
                    }
                }
            }
            Button {
                saveSelectedCracks()
            } label: {
                Label("選択した \(measurer.selectedCount) 本を記録", systemImage: "square.and.arrow.down")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(measurer.selectedCount == 0)
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.bottom, 8)
    }

    private var controls: some View {
        HStack(spacing: 20) {
            Button {
                finish()
            } label: {
                Label("完了", systemImage: "checkmark")
                    .frame(width: 74, height: 46)
            }
            .buttonStyle(.bordered)

            Button {
                Task { await runMeasurement() }
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
            .disabled(measurer.isRunning)

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
        .padding(.bottom, 8)
    }

    private var busyOverlay: some View {
        ZStack {
            Color.black.opacity(0.5).ignoresSafeArea()
            VStack(spacing: 12) {
                ProgressView()
                    .controlSize(.large)
                Text("解析中…")
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

    private func runMeasurement() async {
        measurer.clear()
        guard let capture = await controller.measurementFrame() else {
            measurer.errorMessage = "フレームを取得できませんでした。カメラが動いているか確認してください"
            return
        }
        await measurer.measure(
            frame: capture.frame,
            normalizedRegion: controller.analysisRegion(for: capture.frame),
            targetCrackWidthMM: project.targetCrackWidthMM,
            fallbackEstimate: controller.recentEstimate
        )
        if !capture.isHighResolution, measurer.hasResults {
            measurer.notice = [measurer.notice, "高解像度フレームが取れず、ライブ映像で計測しました（分解能が粗い）"]
                .compactMap { $0 }.joined(separator: "／")
        }
    }

    /// 画面をタップした位置のひび割れ1本だけを計測する。
    private func measureTapped(at location: CGPoint, viewport: CGSize) async {
        guard let capture = await controller.measurementFrame() else {
            measurer.errorMessage = "フレームを取得できませんでした。カメラが動いているか確認してください"
            return
        }
        let frame = capture.frame
        let imageSize = frame.capturedImageSize
        let orientation = ARDisplayMapping.currentOrientation
        let imagePoint = ARDisplayMapping.imagePoint(
            screenPoint: location,
            imageSize: imageSize,
            frame: frame,
            orientation: orientation,
            viewport: viewport
        )
        // 指の大きさ（pt）を画像の px に換算する。48MP では 28pt が 300px 級になる。
        // 固定 24px だと画面の 0.3% しかなく、ほぼ必ず「見つかりません」になる
        let offsetPoint = ARDisplayMapping.imagePoint(
            screenPoint: CGPoint(x: location.x + tapToleranceInPoints, y: location.y),
            imageSize: imageSize,
            frame: frame,
            orientation: orientation,
            viewport: viewport
        )
        let searchRadiusPx = max(24, Int(imagePoint.distance(to: offsetPoint).rounded()))

        await measurer.measureOne(
            frame: frame,
            normalizedRegion: controller.analysisRegion(for: frame),
            imagePoint: imagePoint,
            searchRadiusPx: searchRadiusPx,
            targetCrackWidthMM: project.targetCrackWidthMM,
            fallbackEstimate: controller.recentEstimate
        )
        if !capture.isHighResolution, measurer.hasResults {
            measurer.notice = [measurer.notice, "高解像度フレームが取れず、ライブ映像で計測しました（分解能が粗い）"]
                .compactMap { $0 }.joined(separator: "／")
        }
    }

    private func saveSelectedCracks() {
        let nextNumber = nextLabelNumber()
        let records = measurer.makeRecords(
            startingLabelNumber: nextNumber,
            photoRelativePath: latestPhotoRelativePath()
        )
        guard !records.isEmpty else { return }

        session.cracks.append(contentsOf: records)
        session.frameCount = controller.capturedFrames.count
        session.coverageRatio = controller.coverageRatio
        upsertSession()
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

    /// 直近に保存した写真の、案件フォルダからの相対パス。
    private func latestPhotoRelativePath() -> String? {
        guard let last = controller.capturedFrames.last else { return nil }
        let projectDirectory = store.directory(for: project).path
        let path = last.imageURL.path
        guard path.hasPrefix(projectDirectory) else { return nil }
        return String(path.dropFirst(projectDirectory.count).drop(while: { $0 == "/" }))
    }
}

/// 検出候補のチップ。
private struct CandidateChip: View {
    let candidate: MeasureViewModel.Candidate
    let thresholds: CrackGrade.Thresholds
    let action: () -> Void

    var body: some View {
        let grade = CrackGrade.grade(forWidthMM: candidate.measurement.maxWidthMM, thresholds: thresholds)
        let c = grade.colorComponents

        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(String(format: "%.2f mm", candidate.measurement.maxWidthMM))
                    .font(.subheadline.weight(.bold))
                    .monospacedDigit()
                Text(String(format: "L %.0f mm", candidate.measurement.lengthMM))
                    .font(.caption2)
                if !candidate.measurement.isResolutionSufficient {
                    Label("参考値", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(red: c.red, green: c.green, blue: c.blue).opacity(candidate.isSelected ? 0.85 : 0.25))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(candidate.isSelected ? Color.white : Color.clear, lineWidth: 1.5)
            )
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
    }
}
