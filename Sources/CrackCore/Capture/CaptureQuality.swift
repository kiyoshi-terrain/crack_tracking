import Foundation

/// 1フレームの撮影条件。
public struct CaptureConditions: Sendable {
    /// 対象までの距離（m）
    public var distance: Double
    /// 入射角（度, 0 が正対）
    public var incidenceAngleDegrees: Double
    /// 代表 GSD（mm/px）
    public var millimetersPerPixel: Double
    /// ラプラシアン分散によるピント指標
    public var focusScore: Double
    /// 平均輝度 0...1
    public var meanLuminance: Double
    /// 露出オーバーで飽和している画素の割合 0...1
    public var saturatedRatio: Double
    /// LiDAR 平面フィットの残差 RMS（m）。壁面が平面として取れているか。
    public var planeResidual: Double
    /// ARKit のトラッキングが安定しているか
    public var isTrackingStable: Bool

    public init(
        distance: Double,
        incidenceAngleDegrees: Double,
        millimetersPerPixel: Double,
        focusScore: Double,
        meanLuminance: Double,
        saturatedRatio: Double,
        planeResidual: Double,
        isTrackingStable: Bool
    ) {
        self.distance = distance
        self.incidenceAngleDegrees = incidenceAngleDegrees
        self.millimetersPerPixel = millimetersPerPixel
        self.focusScore = focusScore
        self.meanLuminance = meanLuminance
        self.saturatedRatio = saturatedRatio
        self.planeResidual = planeResidual
        self.isTrackingStable = isTrackingStable
    }
}

/// 撮影品質の判定結果。
public struct CaptureVerdict: Sendable {
    public enum Level: Int, Comparable, Sendable {
        case good = 0
        case warning = 1
        case blocking = 2

        public static func < (l: Level, r: Level) -> Bool { l.rawValue < r.rawValue }
    }

    public struct Issue: Sendable, Identifiable {
        public let id: String
        public let level: Level
        /// 画面に出す日本語の指示
        public let message: String

        public init(id: String, level: Level, message: String) {
            self.id = id
            self.level = level
            self.message = message
        }
    }

    public let issues: [Issue]
    /// 目標幅を計測できる分解能があるか
    public let meetsTargetResolution: Bool

    public var level: Level { issues.map(\.level).max() ?? .good }
    public var canCapture: Bool { level != .blocking }
    /// 画面に出す最優先メッセージ
    public var primaryMessage: String {
        issues.max { $0.level < $1.level }?.message ?? "この位置でOKです"
    }
}

/// 撮影の可否と改善指示を出す。
///
/// 「撮ってから机で気づく」を無くすのが目的なので、しきい値は
/// 現場で撮り直しが効く範囲でやや厳しめに設定しています。
public struct CaptureQualityEvaluator: Sendable {

    public struct Thresholds: Sendable {
        /// 計測したいひび割れ幅（mm）
        public var targetCrackWidthMM: Double
        public var minDistance: Double
        public var maxDistance: Double
        public var warningIncidenceAngle: Double
        public var blockingIncidenceAngle: Double
        /// ピント指標の下限（画像を 0...1 正規化したときのラプラシアン分散）
        public var minFocusScore: Double
        public var minLuminance: Double
        public var maxLuminance: Double
        public var maxSaturatedRatio: Double
        public var maxPlaneResidual: Double

        public init(
            targetCrackWidthMM: Double = 0.2,
            minDistance: Double = 0.25,
            maxDistance: Double = 3.0,
            warningIncidenceAngle: Double = 25,
            blockingIncidenceAngle: Double = 45,
            minFocusScore: Double = 0.0012,
            minLuminance: Double = 0.12,
            maxLuminance: Double = 0.88,
            maxSaturatedRatio: Double = 0.08,
            maxPlaneResidual: Double = 0.02
        ) {
            self.targetCrackWidthMM = targetCrackWidthMM
            self.minDistance = minDistance
            self.maxDistance = maxDistance
            self.warningIncidenceAngle = warningIncidenceAngle
            self.blockingIncidenceAngle = blockingIncidenceAngle
            self.minFocusScore = minFocusScore
            self.minLuminance = minLuminance
            self.maxLuminance = maxLuminance
            self.maxSaturatedRatio = maxSaturatedRatio
            self.maxPlaneResidual = maxPlaneResidual
        }

        public static let `default` = Thresholds()
    }

    public var thresholds: Thresholds

    public init(thresholds: Thresholds = .default) {
        self.thresholds = thresholds
    }

    public func evaluate(_ c: CaptureConditions) -> CaptureVerdict {
        var issues: [CaptureVerdict.Issue] = []

        if !c.isTrackingStable {
            issues.append(.init(
                id: "tracking",
                level: .blocking,
                message: "端末を動かして周囲を認識させてください"
            ))
        }

        // 分解能: これが本質。目標幅の 3px を確保できているか。
        let requiredGSD = CaptureAdvisor.maximumGSD(forCrackWidthMM: thresholds.targetCrackWidthMM)
        let meetsResolution = c.millimetersPerPixel <= requiredGSD
        if !meetsResolution {
            let needed = c.distance * requiredGSD / max(c.millimetersPerPixel, 1e-6)
            if needed < thresholds.minDistance {
                // 「0.1m まで近づけ」と言いながら 0.25m 未満を自分でブロックしていた。
                // 最短距離より近くへは行けないので、その距離で得られる分解能から
                // この端末で測れる最小の幅を逆算し、目標幅の方を直してもらう。
                // 実機（iPhone 16 Pro Max・0.26m・0.19mm/px）で実際に矛盾した助言が出た
                let gsdAtMinDistance = c.millimetersPerPixel * thresholds.minDistance / max(c.distance, 1e-6)
                let measurableMM = gsdAtMinDistance * CaptureAdvisor.defaultMinimumPixelsAcrossCrack
                issues.append(.init(
                    id: "resolution",
                    level: .warning,
                    message: String(
                        format: "分解能不足（%.2f mm/px）。目標幅 %.2f mm は最短の %.2fm まで寄っても足りません。目標幅を %.1f mm 以上にするか、参考値として扱ってください",
                        c.millimetersPerPixel,
                        thresholds.targetCrackWidthMM,
                        thresholds.minDistance,
                        (measurableMM * 10).rounded(.up) / 10
                    )
                ))
            } else {
                issues.append(.init(
                    id: "resolution",
                    level: .warning,
                    message: String(
                        format: "分解能不足（%.2f mm/px）。%.1fm 以内まで近づいてください",
                        c.millimetersPerPixel,
                        needed
                    )
                ))
            }
        }

        if c.distance < thresholds.minDistance {
            issues.append(.init(
                id: "tooClose",
                level: .blocking,
                message: String(format: "近すぎます（%.2fm）。%.2fm 以上離してください", c.distance, thresholds.minDistance)
            ))
        } else if c.distance > thresholds.maxDistance {
            issues.append(.init(
                id: "tooFar",
                level: .warning,
                message: String(format: "遠すぎます（%.1fm）。もう少し近づいてください", c.distance)
            ))
        }

        if c.incidenceAngleDegrees > thresholds.blockingIncidenceAngle {
            issues.append(.init(
                id: "angleBlocking",
                level: .blocking,
                message: String(format: "角度が急すぎます（%.0f°）。壁面に正対してください", c.incidenceAngleDegrees)
            ))
        } else if c.incidenceAngleDegrees > thresholds.warningIncidenceAngle {
            issues.append(.init(
                id: "angleWarning",
                level: .warning,
                message: String(format: "やや斜めです（%.0f°）。正対に近づけると精度が上がります", c.incidenceAngleDegrees)
            ))
        }

        if c.focusScore < thresholds.minFocusScore {
            issues.append(.init(
                id: "focus",
                level: .blocking,
                message: "ピントが合っていません。静止してタップでピントを合わせてください"
            ))
        }

        if c.meanLuminance < thresholds.minLuminance {
            issues.append(.init(
                id: "dark",
                level: .warning,
                message: "暗すぎます。ライトを点灯してください"
            ))
        } else if c.meanLuminance > thresholds.maxLuminance || c.saturatedRatio > thresholds.maxSaturatedRatio {
            issues.append(.init(
                id: "bright",
                level: .warning,
                message: "白飛びしています。露出を下げるか角度を変えてください"
            ))
        }

        if c.planeResidual > thresholds.maxPlaneResidual {
            issues.append(.init(
                id: "plane",
                level: .warning,
                message: "壁面を平面として認識できていません。計測範囲を狭めてください"
            ))
        }

        return CaptureVerdict(issues: issues, meetsTargetResolution: meetsResolution)
    }
}
