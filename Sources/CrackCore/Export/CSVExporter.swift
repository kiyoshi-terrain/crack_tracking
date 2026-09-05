import Foundation

/// 点検帳票用の CSV 出力。
///
/// Excel で開くことを想定して BOM 付き UTF-8 を既定にしています
/// （BOM が無いと Windows 版 Excel が Shift_JIS と誤認して文字化けするため）。
public enum CSVExporter {

    public static func makeCSV(project: InspectionProject, includeBOM: Bool = true) -> Data {
        var rows: [[String]] = []
        rows.append([
            "案件名", "構造物名", "部材名", "亀裂番号", "計測日時",
            "最大幅(mm)", "平均幅(mm)", "延長(mm)", "区分",
            "撮影距離(m)", "入射角(deg)", "分解能(mm/px)", "縦尺補正",
            "幅校正PSFσ(px)", "幅校正オフセット(px)",
            "分解能充足", "信頼度", "手入力幅(mm)", "備考",
        ])

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime, .withDashSeparatorInDate, .withSpaceBetweenDateAndTime]
        formatter.timeZone = TimeZone.current

        for session in project.sessions {
            for crack in session.cracks {
                rows.append([
                    project.name,
                    project.structureName,
                    session.memberName,
                    crack.label,
                    formatter.string(from: crack.measuredAt),
                    format(crack.maxWidthMM, digits: 2),
                    format(crack.meanWidthMM, digits: 2),
                    format(crack.lengthMM, digits: 0),
                    crack.grade(using: project.gradeThresholds).displayName,
                    format(crack.distance, digits: 2),
                    format(crack.incidenceAngleDegrees, digits: 0),
                    format(crack.millimetersPerPixel, digits: 3),
                    crack.scaleCorrection.map { format($0, digits: 3) } ?? "",
                    crack.widthCalibrationSigmaPx.map { format($0, digits: 2) } ?? "",
                    crack.widthCalibrationOffsetPx.map { format($0, digits: 2) } ?? "",
                    crack.isResolutionSufficient ? "○" : "×",
                    format(crack.confidence, digits: 2),
                    crack.manualWidthMM.map { format($0, digits: 2) } ?? "",
                    crack.note,
                ])
            }
        }

        let body = rows.map { $0.map(escape).joined(separator: ",") }.joined(separator: "\r\n")
        var data = Data()
        if includeBOM {
            data.append(contentsOf: [0xEF, 0xBB, 0xBF])
        }
        data.append(Data(body.utf8))
        return data
    }

    /// 1本のひび割れの幅測点を出力する（幅の分布を確認したいとき用）。
    public static func makeWidthProfileCSV(crack: CrackRecord, includeBOM: Bool = true) -> Data {
        var rows: [[String]] = [["亀裂番号", "測点番号", "幅(mm)"]]
        for (i, w) in crack.widthSamplesMM.enumerated() {
            rows.append([crack.label, String(i + 1), format(w, digits: 3)])
        }
        let body = rows.map { $0.map(escape).joined(separator: ",") }.joined(separator: "\r\n")
        var data = Data()
        if includeBOM { data.append(contentsOf: [0xEF, 0xBB, 0xBF]) }
        data.append(Data(body.utf8))
        return data
    }

    static func escape(_ field: String) -> String {
        if field.contains(",") || field.contains("\"") || field.contains("\n") || field.contains("\r") {
            return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return field
    }

    static func format(_ value: Double, digits: Int) -> String {
        guard value.isFinite else { return "" }
        return String(format: "%.\(digits)f", value)
    }
}
