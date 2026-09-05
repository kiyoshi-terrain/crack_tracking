import SwiftUI
import CrackCore

/// 撮った静止画の上で亀裂をなぞって測り、記録するものを選ぶ画面。
///
/// ライブ映像の上で測ると、手が動くたびに結果がずれ、何を測ったのか確かめられない。
/// 静止画に固定して、ピンチで拡大しながら「この亀裂のこの区間」を指で示す。
@MainActor
struct StillReviewView: View {
    @ObservedObject var measurer: MeasureViewModel
    let project: InspectionProject
    /// 選択したものを記録する（呼び出し側が保存して閉じる）
    let onRecord: () -> Void
    /// 撮り直す（閉じる）
    let onRetake: () -> Void

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let still = measurer.still {
                ZoomableStillView(
                    image: still.display,
                    frameRect: still.analysisRegionDisplay,
                    lines: overlayLines,
                    guideStrokes: measurer.strokesDisplay.map { $0.map { CGPoint(x: $0.x, y: $0.y) } },
                    onStroke: { points, radius in
                        Task {
                            await measurer.measureAlong(
                                displayStroke: points.map { Vec2($0.x, $0.y) },
                                searchRadiusPx: Double(radius),
                                targetCrackWidthMM: project.targetCrackWidthMM
                            )
                        }
                    },
                    onTap: { point, radius in
                        if let id = measurer.nearestCandidate(toDisplayPoint: Vec2(point.x, point.y), within: Double(radius)) {
                            measurer.toggle(id)
                        }
                    }
                )
                .ignoresSafeArea()
            }

            VStack(spacing: 8) {
                topBar
                ForEach(measurer.notices, id: \.self) { notice in
                    banner(notice, color: .orange, icon: "exclamationmark.triangle.fill")
                }
                Spacer()
                bottomPanel
            }
            .padding()

            if measurer.isRunning {
                busyOverlay
            }
        }
        .statusBarHidden()
        .alert("計測できませんでした", isPresented: Binding(
            get: { measurer.errorMessage != nil },
            set: { if !$0 { measurer.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { measurer.errorMessage = nil }
        } message: {
            Text(measurer.errorMessage ?? "")
        }
    }

    // MARK: - パーツ

    private var overlayLines: [StillOverlayLine] {
        measurer.candidates.map { candidate in
            let grade = CrackGrade.grade(forWidthMM: candidate.measurement.maxWidthMM, thresholds: project.gradeThresholds)
            let c = grade.colorComponents
            return StillOverlayLine(
                id: candidate.id,
                points: candidate.centerlineDisplay.map { CGPoint(x: $0.x, y: $0.y) },
                color: UIColor(red: c.red, green: c.green, blue: c.blue, alpha: 1),
                isSelected: candidate.isSelected,
                label: String(format: "%.2f mm", candidate.measurement.maxWidthMM)
            )
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button {
                onRetake()
            } label: {
                Label("撮り直す", systemImage: "arrow.counterclockwise")
                    .font(.footnote.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .tint(.white)

            Spacer()

            if let still = measurer.still {
                HStack(spacing: 10) {
                    metric(String(format: "%.3f", still.millimetersPerPixel), unit: "mm/px")
                    metric(String(format: "%.2f", still.distance), unit: "m")
                    if !still.isHighResolution {
                        Text("ライブ")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.orange)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    private func metric(_ value: String, unit: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 2) {
            Text(value)
                .font(.footnote.weight(.bold))
                .monospacedDigit()
            Text(unit)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var bottomPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            if measurer.candidates.isEmpty {
                Label(
                    "亀裂に沿って 1 本の指でなぞると、その線の幅を測ります。2 本指で移動、ピンチで拡大。",
                    systemImage: "hand.draw"
                )
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            } else {
                HStack {
                    Text("検出 \(measurer.candidates.count) 本／選択 \(measurer.selectedCount) 本")
                        .font(.footnote.weight(.semibold))
                    Spacer()
                    Text("線かチップをタップで選択")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if measurer.rejectedCount > 0 {
                    Text("\(measurer.rejectedCount) 本を亀裂ではないと判断して除外しました（短い・幅に対して短い・信頼度が低い）")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(measurer.candidates) { candidate in
                            CandidateChip(candidate: candidate, thresholds: project.gradeThresholds) {
                                measurer.toggle(candidate.id)
                            }
                        }
                    }
                }
            }

            HStack(spacing: 10) {
                Button {
                    Task { await measurer.measureAll(targetCrackWidthMM: project.targetCrackWidthMM) }
                } label: {
                    Label("枠内を全部測る", systemImage: "viewfinder")
                        .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .disabled(measurer.isRunning)

                Button {
                    onRecord()
                } label: {
                    Label("選択した \(measurer.selectedCount) 本を記録", systemImage: "square.and.arrow.down")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(measurer.selectedCount == 0)
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private var busyOverlay: some View {
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea()
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

    private func banner(_ message: String, color: Color, icon: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon)
            Text(message)
                .font(.footnote.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(color.opacity(0.85), in: RoundedRectangle(cornerRadius: 10))
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
