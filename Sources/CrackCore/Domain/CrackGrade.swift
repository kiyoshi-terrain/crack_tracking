import Foundation

/// ひび割れ幅による区分。
///
/// **注意**: 既定値は一般に目安として用いられる 0.2 / 0.3 / 0.5 mm を並べたものです。
/// 適用すべき判定基準は発注者・構造物種別・点検要領によって異なるため、
/// 実運用では案件ごとに `InspectionProject.gradeThresholds` を設定してください。
/// 本アプリは計測値を提示するものであり、健全性の判定を代替するものではありません。
public enum CrackGrade: String, Codable, CaseIterable, Sendable {
    /// ヘアクラック相当
    case hairline
    /// 経過観察
    case minor
    /// 要注意
    case moderate
    /// 要詳細調査
    case severe

    public struct Thresholds: Codable, Hashable, Sendable {
        public var minor: Double
        public var moderate: Double
        public var severe: Double

        public init(minor: Double = 0.2, moderate: Double = 0.3, severe: Double = 0.5) {
            self.minor = minor
            self.moderate = moderate
            self.severe = severe
        }

        public static let `default` = Thresholds()
    }

    public static func grade(forWidthMM width: Double, thresholds: Thresholds = .default) -> CrackGrade {
        if width >= thresholds.severe { return .severe }
        if width >= thresholds.moderate { return .moderate }
        if width >= thresholds.minor { return .minor }
        return .hairline
    }

    public var displayName: String {
        switch self {
        case .hairline: return "ヘアクラック"
        case .minor: return "経過観察"
        case .moderate: return "要注意"
        case .severe: return "要詳細調査"
        }
    }

    /// 表示色（RGB, 0...1）。UI 層で Color に変換する。
    public var colorComponents: (red: Double, green: Double, blue: Double) {
        switch self {
        case .hairline: return (0.30, 0.72, 0.42)
        case .minor: return (0.95, 0.77, 0.20)
        case .moderate: return (0.96, 0.52, 0.14)
        case .severe: return (0.90, 0.24, 0.24)
        }
    }
}
