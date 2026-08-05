import SwiftUI
import Charts
import CrackCore

/// 1本のひび割れの詳細。幅の分布と、必要なら手入力での上書き。
struct CrackDetailView: View {
    @Binding var crack: CrackRecord
    let thresholds: CrackGrade.Thresholds

    @State private var isEditingWidth = false
    @State private var manualWidthText = ""

    var body: some View {
        List {
            headerSection
            measurementSection
            if !crack.widthSamplesMM.isEmpty {
                profileSection
            }
            qualitySection
            noteSection
        }
        .navigationTitle(crack.label)
        .navigationBarTitleDisplayMode(.inline)
        .alert("幅を手入力で上書き", isPresented: $isEditingWidth) {
            TextField("幅（mm）", text: $manualWidthText)
                .keyboardType(.decimalPad)
            Button("保存") {
                crack.manualWidthMM = Double(manualWidthText)
            }
            Button("自動計測値に戻す", role: .destructive) {
                crack.manualWidthMM = nil
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("クラックスケールで実測した値がある場合はこちらを優先します")
        }
    }

    private var headerSection: some View {
        Section {
            let grade = crack.grade(using: thresholds)
            let c = grade.colorComponents
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(String(format: "%.2f mm", crack.reportedWidthMM))
                        .font(.system(size: 40, weight: .bold, design: .rounded))
                        .monospacedDigit()
                    Text(grade.displayName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color(red: c.red, green: c.green, blue: c.blue))
                }
                Spacer()
                if crack.manualWidthMM != nil {
                    Label("手入力", systemImage: "pencil")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
            .padding(.vertical, 4)

            Button {
                manualWidthText = crack.manualWidthMM.map { String(format: "%.2f", $0) } ?? ""
                isEditingWidth = true
            } label: {
                Label("幅を手入力で上書き", systemImage: "pencil")
            }
        }
    }

    private var measurementSection: some View {
        Section("計測値") {
            LabeledContent("最大幅（自動）", value: String(format: "%.2f mm", crack.maxWidthMM))
            LabeledContent("平均幅", value: String(format: "%.2f mm", crack.meanWidthMM))
            LabeledContent("延長", value: String(format: "%.0f mm", crack.lengthMM))
            LabeledContent("測点数", value: "\(crack.widthSamplesMM.count)")
        }
    }

    private var profileSection: some View {
        Section {
            Chart {
                ForEach(Array(crack.widthSamplesMM.enumerated()), id: \.offset) { index, width in
                    LineMark(
                        x: .value("測点", index),
                        y: .value("幅", width)
                    )
                    .foregroundStyle(Color.accentColor)
                }
                RuleMark(y: .value("目標", thresholds.minor))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .foregroundStyle(.secondary)
            }
            .chartYAxisLabel("幅 (mm)")
            .frame(height: 160)
        } header: {
            Text("幅の分布")
        } footer: {
            Text("ひび割れは全長で幅が変わります。帳票には上位5%点を「最大幅」として載せています（単発のノイズを最大値として拾わないため）。")
        }
    }

    private var qualitySection: some View {
        Section {
            LabeledContent("撮影距離", value: String(format: "%.2f m", crack.distance))
            LabeledContent("入射角", value: String(format: "%.0f °", crack.incidenceAngleDegrees))
            LabeledContent("分解能", value: String(format: "%.3f mm/px", crack.millimetersPerPixel))
            LabeledContent("信頼度", value: String(format: "%.0f %%", crack.confidence * 100))

            if !crack.isResolutionSufficient {
                Label(
                    "ひび割れが 3px 未満でしか写っておらず、幅が過大に出ている可能性があります。近接して撮り直すか、クラックスケールで実測してください。",
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
        } header: {
            Text("撮影条件")
        }
    }

    private var noteSection: some View {
        Section("所見") {
            TextField("メモ", text: $crack.note, axis: .vertical)
                .lineLimit(3...8)
        }
    }
}
