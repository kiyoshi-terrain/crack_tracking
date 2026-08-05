import SwiftUI
import CrackCore

/// 撮影中に常時出す数値と指示。
///
/// 「今この位置で撮って良いか」を一目で判断できることが重要なので、
/// 分解能（mm/px）を最も大きく出し、目標幅を満たすかどうかで色を変えます。
struct CaptureHUD: View {
    let verdict: CaptureVerdict?
    let conditions: CaptureConditions?
    let trackingMessage: String?
    let frameCount: Int
    let coverageRatio: Double
    let targetWidthMM: Double

    var body: some View {
        VStack(spacing: 8) {
            if let message = trackingMessage {
                banner(message, color: .orange, icon: "arrow.triangle.2.circlepath")
            }

            if let verdict, verdict.level != .good {
                banner(
                    verdict.primaryMessage,
                    color: verdict.level == .blocking ? .red : .yellow,
                    icon: verdict.level == .blocking ? "xmark.octagon.fill" : "exclamationmark.triangle.fill"
                )
            } else if verdict != nil {
                banner("この位置で計測できます", color: .green, icon: "checkmark.circle.fill")
            }

            metrics
        }
    }

    private var metrics: some View {
        HStack(spacing: 0) {
            metric(
                title: "分解能",
                value: conditions.map { String(format: "%.3f", $0.millimetersPerPixel) } ?? "—",
                unit: "mm/px",
                highlight: true,
                color: resolutionColor
            )
            divider
            metric(
                title: "距離",
                value: conditions.map { String(format: "%.2f", $0.distance) } ?? "—",
                unit: "m"
            )
            divider
            metric(
                title: "入射角",
                value: conditions.map { String(format: "%.0f", $0.incidenceAngleDegrees) } ?? "—",
                unit: "°"
            )
            divider
            metric(
                title: "記録",
                value: "\(frameCount)",
                unit: "枚"
            )
        }
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.15))
            .frame(width: 1, height: 30)
    }

    private var resolutionColor: Color {
        guard let conditions else { return .secondary }
        let required = CaptureAdvisor.maximumGSD(forCrackWidthMM: targetWidthMM)
        if conditions.millimetersPerPixel <= required { return .green }
        if conditions.millimetersPerPixel <= required * 1.5 { return .yellow }
        return .red
    }

    private func metric(
        title: String,
        value: String,
        unit: String,
        highlight: Bool = false,
        color: Color = .primary
    ) -> some View {
        VStack(spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(value)
                    .font(highlight ? .title3.weight(.bold) : .body.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(color)
                Text(unit)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
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
