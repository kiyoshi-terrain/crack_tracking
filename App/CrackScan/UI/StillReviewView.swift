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
    /// 幅校正が変わった（案件に保存してもらう。nil は校正なしに戻す）
    let onCalibrate: (WidthCalibration?) -> Void

    /// 縮尺合わせに入力する既知の長さ（mm）
    @State private var knownLengthText = "100"
    /// 幅校正に入力する既知の幅（mm）
    @State private var knownWidthText = "0.50"
    /// 照準（画面中央）の位置を聞くための取っ手
    @State private var aim = StillAimHandle()
    @State private var isConfirmingClearScale = false
    @State private var isConfirmingClearCalibration = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let still = measurer.still {
                ZoomableStillView(
                    image: still.display,
                    frameRect: still.analysisRegionDisplay,
                    lines: overlayLines,
                    guideStrokes: measurer.strokesDisplay.map { $0.map { CGPoint(x: $0.x, y: $0.y) } },
                    scaleMarks: measurer.scaleMarksDisplay.map { CGPoint(x: $0.x, y: $0.y) },
                    scaleLabel: scaleLabel,
                    onStroke: { points, radius in
                        // 目印を置いている間は、なぞっても測らない（誤操作を避ける）
                        guard !measurer.isPlacingScale else { return }
                        Task {
                            await measurer.measureAlong(
                                displayStroke: points.map { Vec2($0.x, $0.y) },
                                searchRadiusPx: Double(radius),
                                targetCrackWidthMM: project.targetCrackWidthMM
                            )
                        }
                    },
                    onTap: { point, radius in
                        // 照準モードではタップは止めてある（誤操作で目印がずれるため）
                        guard !measurer.isPlacingScale else { return }
                        if let id = measurer.nearestCandidate(toDisplayPoint: Vec2(point.x, point.y), within: Double(radius)) {
                            measurer.toggle(id)
                        }
                    },
                    isAiming: measurer.isPlacingScale,
                    aim: aim
                )
                .ignoresSafeArea()
                .overlay {
                    if measurer.isPlacingScale {
                        // 十字を描いた位置そのものを「置く点」にする（別々に中央を計算しない）
                        GeometryReader { geometry in
                            let frame = geometry.frame(in: .global)
                            aimReticle
                                .position(x: geometry.size.width / 2, y: geometry.size.height / 2)
                                .onChange(of: frame, initial: true) { _, f in
                                    aim.reticleCenterInWindow = CGPoint(x: f.midX, y: f.midY)
                                }
                        }
                        .allowsHitTesting(false)
                    }
                }
            }

            VStack(spacing: 8) {
                topBar
                ForEach(measurer.notices, id: \.self) { notice in
                    banner(notice, color: .orange, icon: "exclamationmark.triangle.fill")
                }
                Spacer()
                if measurer.isPlacingScale {
                    scalePanel
                } else if measurer.isCalibratingWidth {
                    widthCalibrationPanel
                } else {
                    bottomPanel
                }
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
        .confirmationDialog("縮尺補正を外しますか？", isPresented: $isConfirmingClearScale, titleVisibility: .visible) {
            Button("LiDAR の縮尺に戻す", role: .destructive) { measurer.clearScaleCorrection() }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("測った候補の幅・延長も LiDAR の縮尺に戻ります")
        }
        .confirmationDialog("幅校正を外しますか？", isPresented: $isConfirmingClearCalibration, titleVisibility: .visible) {
            Button("設計値に戻す", role: .destructive) {
                measurer.clearWidthCalibration()
                onCalibrate(nil)
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("既知幅の線から決めた σ と太りを捨て、設計値（σ 0.8 px）に戻します。案件の設定も戻ります")
        }
    }

    /// 目印 2 点のあいだに出すラベル
    private var scaleLabel: String? {
        if let correction = measurer.still?.scaleCorrection, !measurer.isPlacingScale {
            return String(format: "%.0f mm（×%.3f）", correction.knownMM, correction.factor)
        }
        if let measured = measurer.scaleMarksMeasuredMM {
            return String(format: "%.1f mm", measured)
        }
        return nil
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

            Button {
                if measurer.isPlacingScale {
                    measurer.cancelPlacingScale()
                } else {
                    measurer.beginPlacingScale()
                }
            } label: {
                Label(measurer.isPlacingScale ? "やめる" : "縮尺", systemImage: "ruler")
                    .font(.footnote.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .tint(measurer.isPlacingScale ? .cyan : .white)

            Spacer()

            if let still = measurer.still {
                HStack(spacing: 10) {
                    metric(String(format: "%.3f", still.millimetersPerPixel), unit: "mm/px")
                    metric(String(format: "%.2f", still.distance), unit: "m")
                    if let correction = still.scaleCorrection {
                        Button {
                            isConfirmingClearScale = true
                        } label: {
                            Text(String(format: "×%.3f", correction.factor))
                                .font(.caption2.weight(.bold))
                                .monospacedDigit()
                                .foregroundStyle(.cyan)
                        }
                        .buttonStyle(.plain)
                    }
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

    /// 縮尺合わせの操作（目印を置いている間だけ出す）
    private var scalePanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            if measurer.scaleMarksDisplay.count < 2 {
                Label(
                    measurer.scaleMarksDisplay.isEmpty
                        ? "既知の長さ（100 mm の目印など）の片方の端に画面中央の十字を合わせて「ここに置く」。"
                            + "1 本指で画像を動かせます。ピンチで拡大するほど正確です"
                        : "もう片方の端に十字を合わせて「ここに置く」",
                    systemImage: "scope"
                )
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 10) {
                    // 1px の微調整。指では 1px は動かせないので矢印で
                    nudgeButton("chevron.left", dx: -1, dy: 0)
                    nudgeButton("chevron.up", dx: 0, dy: -1)
                    nudgeButton("chevron.down", dx: 0, dy: 1)
                    nudgeButton("chevron.right", dx: 1, dy: 0)
                    Button {
                        guard let point = aim.aimPoint else { return }
                        measurer.addScaleMark(Vec2(point.x, point.y))
                    } label: {
                        Label("ここに置く", systemImage: "scope")
                            .font(.footnote.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.cyan)
                }
            } else {
                if let measured = measurer.scaleMarksMeasuredMM {
                    Text(String(format: "LiDAR の縮尺では %.1f mm。実際の長さを入れてください", measured))
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack(spacing: 10) {
                    TextField("実際の長さ", text: $knownLengthText)
                        .keyboardType(.decimalPad)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 110)
                        .monospacedDigit()
                    Text("mm")
                        .font(.footnote)
                    Spacer()
                    Button {
                        if let known = Double(knownLengthText.trimmingCharacters(in: .whitespaces)) {
                            measurer.applyScaleCorrection(knownLengthMM: known)
                        } else {
                            measurer.errorMessage = "長さを数字で入れてください（例: 100）"
                        }
                    } label: {
                        Label("この長さで合わせる", systemImage: "checkmark")
                            .font(.footnote.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.cyan)
                }
                HStack(spacing: 8) {
                    Text("目印がずれていたら置き直してください")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button("置き直す") { measurer.beginPlacingScale() }
                        .font(.caption2)
                }
            }
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    /// 照準を 1px ずらすボタン
    private func nudgeButton(_ symbol: String, dx: CGFloat, dy: CGFloat) -> some View {
        Button {
            aim.nudge(dx: dx, dy: dy)
        } label: {
            Image(systemName: symbol)
                .font(.footnote.weight(.bold))
                .frame(width: 34, height: 30)
        }
        .buttonStyle(.bordered)
    }

    /// 画面中央の照準。中心は空けてあり、狙う点そのものは何にも隠されない。
    private var aimReticle: some View {
        ZStack {
            aimCross.stroke(Color.black.opacity(0.7), lineWidth: 3)
            aimCross.stroke(Color.cyan, lineWidth: 1)
        }
        .frame(width: 64, height: 64)
    }

    private var aimCross: Path {
        Path { p in
            let c: CGFloat = 32, gap: CGFloat = 7, arm: CGFloat = 30
            p.move(to: CGPoint(x: c - arm, y: c)); p.addLine(to: CGPoint(x: c - gap, y: c))
            p.move(to: CGPoint(x: c + gap, y: c)); p.addLine(to: CGPoint(x: c + arm, y: c))
            p.move(to: CGPoint(x: c, y: c - arm)); p.addLine(to: CGPoint(x: c, y: c - gap))
            p.move(to: CGPoint(x: c, y: c + gap)); p.addLine(to: CGPoint(x: c, y: c + arm))
        }
    }

    /// 幅校正（既知幅の線の実幅を入れてもらう）
    private var widthCalibrationPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let target = measurer.calibrationTarget {
                Text(String(
                    format: "選んだ線は いま %.2f mm（半値幅 %.1f px）。この線の実際の幅を入れてください",
                    target.measurement.maxWidthMM,
                    target.measurement.medianRawWidthPx ?? 0
                ))
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 10) {
                TextField("実際の幅", text: $knownWidthText)
                    .keyboardType(.decimalPad)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 110)
                    .monospacedDigit()
                Text("mm")
                    .font(.footnote)
                Spacer()
                Button {
                    measurer.cancelWidthCalibration()
                } label: {
                    Text("やめる").font(.footnote)
                }
                .buttonStyle(.bordered)
                Button {
                    guard let known = Double(knownWidthText.trimmingCharacters(in: .whitespaces)) else {
                        measurer.errorMessage = "幅を数字で入れてください（例: 0.50）"
                        return
                    }
                    if let fitted = measurer.applyWidthCalibration(knownWidthMM: known) {
                        onCalibrate(fitted)
                    }
                } label: {
                    Label("この幅で合わせる", systemImage: "checkmark")
                        .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .tint(.mint)
            }
            Text("先に「縮尺」を合わせてください（既知幅を px に直すのに分解能を使います）。"
                + "太い線と細い線の 2 通りを入れると、ボケ（σ）と一定の太りを分けて決められます")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    /// 幅校正の状態（測ってあるときだけ出す）
    @ViewBuilder
    private var calibrationStatus: some View {
        let calibration = measurer.calibration
        if calibration.isMeasured {
            HStack(spacing: 6) {
                Image(systemName: "ruler.fill")
                    .font(.caption2)
                Text(String(
                    format: "幅校正 σ %.2f px ／ 太り %+.1f px（既知幅 %d 点%@）",
                    calibration.psfSigmaPx,
                    calibration.offsetPx,
                    calibration.points.count,
                    calibration.rmsResidualPx.map { String(format: "・残差 %.2f px", $0) } ?? ""
                ))
                .font(.caption2)
                .monospacedDigit()
                Spacer(minLength: 0)
                Button("外す") { isConfirmingClearCalibration = true }
                    .font(.caption2)
            }
            .foregroundStyle(.mint)
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
            // 校正の状態は、まだ何も測っていないときも出す（効いているのに見えないのが最悪）
            calibrationStatus
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

                // 既知幅の線（クラックスケールの目盛りなど）を測ってから押す
                Button {
                    measurer.beginWidthCalibration()
                } label: {
                    Label("幅校正", systemImage: "ruler.fill")
                        .font(.footnote.weight(.semibold))
                }
                .buttonStyle(.bordered)
                .tint(measurer.calibrationTarget == nil ? .white : .mint)

                Spacer(minLength: 0)
            }

            Button {
                onRecord()
            } label: {
                Label("選択した \(measurer.selectedCount) 本を記録", systemImage: "square.and.arrow.down")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(measurer.selectedCount == 0)
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
