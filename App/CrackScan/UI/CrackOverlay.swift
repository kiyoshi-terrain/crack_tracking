import ARKit
import SwiftUI
import CrackCore

/// 検出したひび割れの芯線をカメラ映像に重ねて描く。
struct CrackOverlay: View {
    let candidates: [MeasureViewModel.Candidate]
    let imageSize: CGSize
    let frame: ARFrame?
    let viewport: CGSize
    let thresholds: CrackGrade.Thresholds
    let onTap: (UUID) -> Void

    var body: some View {
        ZStack {
            ForEach(candidates) { candidate in
                let points = screenPoints(for: candidate)
                if points.count >= 2 {
                    let grade = CrackGrade.grade(
                        forWidthMM: candidate.measurement.maxWidthMM,
                        thresholds: thresholds
                    )
                    let c = grade.colorComponents
                    let color = Color(red: c.red, green: c.green, blue: c.blue)

                    path(points)
                        .stroke(
                            color.opacity(candidate.isSelected ? 1.0 : 0.4),
                            style: StrokeStyle(
                                lineWidth: candidate.isSelected ? 3 : 2,
                                lineCap: .round,
                                lineJoin: .round
                            )
                        )
                        // 線そのものは細くてタップしづらいので、
                        // ほぼ透明な太い線を重ねて当たり判定を広げる
                        .overlay(
                            path(points)
                                .stroke(Color.white.opacity(0.002), lineWidth: 32)
                                .onTapGesture { onTap(candidate.id) }
                        )

                    if let anchor = points.first {
                        widthLabel(candidate: candidate, color: color)
                            .position(x: anchor.x, y: max(16, anchor.y - 18))
                    }
                }
            }
        }
        .allowsHitTesting(!candidates.isEmpty)
    }

    private func path(_ points: [CGPoint]) -> Path {
        Path { p in
            p.move(to: points[0])
            for point in points.dropFirst() { p.addLine(to: point) }
        }
    }

    private func widthLabel(candidate: MeasureViewModel.Candidate, color: Color) -> some View {
        Text(String(format: "%.2f mm", candidate.measurement.maxWidthMM))
            .font(.caption2.weight(.bold))
            .monospacedDigit()
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(color.opacity(candidate.isSelected ? 0.9 : 0.4), in: Capsule())
            .foregroundStyle(.white)
    }

    private func screenPoints(for candidate: MeasureViewModel.Candidate) -> [CGPoint] {
        guard let frame, imageSize.width > 0, viewport.width > 0 else { return [] }
        let orientation = ARDisplayMapping.currentOrientation
        return candidate.centerlineInImage.map { point in
            ARDisplayMapping.screenPoint(
                imagePoint: point,
                imageSize: imageSize,
                frame: frame,
                orientation: orientation,
                viewport: viewport
            )
        }
    }
}
