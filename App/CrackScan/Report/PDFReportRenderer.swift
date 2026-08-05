import Foundation
import UIKit
import CrackCore

/// ひび割れ点検調書（PDF）を生成する。
///
/// 現場で撮ってその場で提出できることを狙って、
/// 一覧表 + 各ひび割れの写真付き明細という一般的な調書構成にしています。
///
/// UIKit の描画コンテキストを使い、`@MainActor` の `ProjectStore` から
/// 写真のパスを引くため、この型自体も MainActor に固定しています。
@MainActor
struct PDFReportRenderer {

    /// A4 縦（72dpi ポイント）
    static let pageSize = CGSize(width: 595.2, height: 841.8)
    private let margin: CGFloat = 40

    private let project: InspectionProject
    private let store: ProjectStore

    init(project: InspectionProject, store: ProjectStore) {
        self.project = project
        self.store = store
    }

    func render() -> Data {
        let renderer = UIGraphicsPDFRenderer(
            bounds: CGRect(origin: .zero, size: Self.pageSize),
            format: makeFormat()
        )

        return renderer.pdfData { context in
            context.beginPage()
            let headerBottom = drawHeader(in: context)
            _ = drawSummaryTable(startingAt: headerBottom, context: context)

            for session in project.sessions {
                for crack in session.cracks {
                    context.beginPage()
                    drawCrackDetail(crack: crack, session: session)
                }
            }
        }
    }

    private func makeFormat() -> UIGraphicsPDFRendererFormat {
        let format = UIGraphicsPDFRendererFormat()
        format.documentInfo = [
            kCGPDFContextTitle as String: "\(project.name) ひび割れ点検調書",
            kCGPDFContextAuthor as String: project.inspectorName,
            kCGPDFContextCreator as String: "CrackScan",
        ]
        return format
    }

    // MARK: - 描画

    private func drawHeader(in context: UIGraphicsPDFRendererContext) -> CGFloat {
        var y = margin

        draw("ひび割れ点検調書", at: CGPoint(x: margin, y: y), font: .boldSystemFont(ofSize: 20))
        y += 32

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy年M月d日 HH:mm"
        formatter.locale = Locale(identifier: "ja_JP")

        let rows: [(String, String)] = [
            ("案件名", project.name),
            ("構造物名", project.structureName),
            ("点検者", project.inspectorName),
            ("作成日時", formatter.string(from: Date())),
            ("計測目標幅", String(format: "%.2f mm", project.targetCrackWidthMM)),
            ("ひび割れ本数", "\(project.allCracks.count) 本"),
        ]
        for (label, value) in rows {
            draw(label, at: CGPoint(x: margin, y: y), font: .systemFont(ofSize: 10), color: .darkGray)
            draw(value, at: CGPoint(x: margin + 90, y: y), font: .systemFont(ofSize: 10))
            y += 16
        }

        y += 8
        drawLine(from: CGPoint(x: margin, y: y), to: CGPoint(x: Self.pageSize.width - margin, y: y))
        return y + 16
    }

    private func drawSummaryTable(startingAt startY: CGFloat, context: UIGraphicsPDFRendererContext) -> CGFloat {
        var y = startY
        draw("計測一覧", at: CGPoint(x: margin, y: y), font: .boldSystemFont(ofSize: 13))
        y += 22

        let columns: [(String, CGFloat)] = [
            ("番号", 50),
            ("部材", 110),
            ("最大幅(mm)", 65),
            ("延長(mm)", 60),
            ("区分", 70),
            ("距離(m)", 50),
            ("分解能", 50),
        ]

        func drawRow(_ values: [String], font: UIFont, background: UIColor? = nil) {
            if let background {
                let rect = CGRect(x: margin, y: y - 2, width: Self.pageSize.width - margin * 2, height: 16)
                background.setFill()
                UIBezierPath(rect: rect).fill()
            }
            var x = margin
            for (index, column) in columns.enumerated() {
                draw(values[index], at: CGPoint(x: x + 2, y: y), font: font)
                x += column.1
            }
            y += 16
        }

        drawRow(columns.map(\.0), font: .boldSystemFont(ofSize: 9), background: UIColor(white: 0.92, alpha: 1))

        for session in project.sessions {
            for crack in session.cracks {
                if y > Self.pageSize.height - margin - 40 {
                    context.beginPage()
                    y = margin
                    drawRow(columns.map(\.0), font: .boldSystemFont(ofSize: 9), background: UIColor(white: 0.92, alpha: 1))
                }
                let grade = crack.grade(using: project.gradeThresholds)
                drawRow([
                    crack.label,
                    session.memberName,
                    String(format: "%.2f", crack.reportedWidthMM),
                    String(format: "%.0f", crack.lengthMM),
                    grade.displayName,
                    String(format: "%.2f", crack.distance),
                    crack.isResolutionSufficient ? "○" : "△参考値",
                ], font: .systemFont(ofSize: 9))
            }
        }

        y += 12
        draw(
            "※「分解能」が△の行は、ひび割れが計測に必要な画素数（3px）未満で写っており、"
                + "幅が過大に出ている可能性があります。近接して撮り直すか、クラックスケールで実測してください。",
            at: CGPoint(x: margin, y: y),
            font: .systemFont(ofSize: 8),
            color: .darkGray,
            width: Self.pageSize.width - margin * 2
        )
        return y + 30
    }

    private func drawCrackDetail(crack: CrackRecord, session: CaptureSession) {
        var y = margin
        let grade = crack.grade(using: project.gradeThresholds)

        draw("\(crack.label)　\(session.memberName)", at: CGPoint(x: margin, y: y), font: .boldSystemFont(ofSize: 16))
        y += 26

        // 区分バッジ
        let components = grade.colorComponents
        let badgeColor = UIColor(
            red: CGFloat(components.red),
            green: CGFloat(components.green),
            blue: CGFloat(components.blue),
            alpha: 1
        )
        let badgeRect = CGRect(x: margin, y: y, width: 90, height: 20)
        badgeColor.setFill()
        UIBezierPath(roundedRect: badgeRect, cornerRadius: 4).fill()
        draw(grade.displayName, at: CGPoint(x: margin + 8, y: y + 4), font: .boldSystemFont(ofSize: 10), color: .white)
        y += 32

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy/MM/dd HH:mm"
        let rows: [(String, String)] = [
            ("最大幅", String(format: "%.2f mm", crack.reportedWidthMM)),
            ("平均幅", String(format: "%.2f mm", crack.meanWidthMM)),
            ("延長", String(format: "%.0f mm", crack.lengthMM)),
            ("撮影距離", String(format: "%.2f m", crack.distance)),
            ("入射角", String(format: "%.0f °", crack.incidenceAngleDegrees)),
            ("分解能", String(format: "%.3f mm/px", crack.millimetersPerPixel)),
            ("信頼度", String(format: "%.0f %%", crack.confidence * 100)),
            ("計測日時", formatter.string(from: crack.measuredAt)),
        ]
        for (label, value) in rows {
            draw(label, at: CGPoint(x: margin, y: y), font: .systemFont(ofSize: 10), color: .darkGray)
            draw(value, at: CGPoint(x: margin + 80, y: y), font: .systemFont(ofSize: 10))
            y += 16
        }

        if crack.manualWidthMM != nil {
            draw("※ 幅は手入力で上書きされています", at: CGPoint(x: margin, y: y),
                 font: .systemFont(ofSize: 9), color: .systemOrange)
            y += 16
        }
        if !crack.isResolutionSufficient {
            draw("※ 分解能不足のため参考値です", at: CGPoint(x: margin, y: y),
                 font: .systemFont(ofSize: 9), color: .systemRed)
            y += 16
        }
        if !crack.note.isEmpty {
            y += 6
            draw("所見", at: CGPoint(x: margin, y: y), font: .boldSystemFont(ofSize: 10))
            y += 16
            draw(crack.note, at: CGPoint(x: margin, y: y), font: .systemFont(ofSize: 10),
                 width: Self.pageSize.width - margin * 2)
            y += 40
        }

        // 写真
        if let relative = crack.photoRelativePath {
            let url = store.directory(for: project).appendingPathComponent(relative)
            if let image = UIImage(contentsOfFile: url.path) {
                let maxWidth = Self.pageSize.width - margin * 2
                let maxHeight = Self.pageSize.height - y - margin
                let scale = min(maxWidth / image.size.width, maxHeight / image.size.height, 1)
                let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                image.draw(in: CGRect(origin: CGPoint(x: margin, y: y), size: size))
            }
        }
    }

    // MARK: - 描画ヘルパ

    private func draw(
        _ text: String,
        at point: CGPoint,
        font: UIFont,
        color: UIColor = .black,
        width: CGFloat? = nil
    ) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color,
        ]
        if let width {
            let rect = CGRect(x: point.x, y: point.y, width: width, height: 200)
            (text as NSString).draw(with: rect, options: [.usesLineFragmentOrigin], attributes: attributes, context: nil)
        } else {
            (text as NSString).draw(at: point, withAttributes: attributes)
        }
    }

    private func drawLine(from: CGPoint, to: CGPoint) {
        let path = UIBezierPath()
        path.move(to: from)
        path.addLine(to: to)
        path.lineWidth = 0.5
        UIColor.lightGray.setStroke()
        path.stroke()
    }
}
