import Foundation

/// 点検案件（現場単位）。
public struct InspectionProject: Codable, Identifiable, Sendable, Hashable {
    public var id: UUID
    public var name: String
    /// 構造物名（例: ○○高架橋 P3 橋脚）
    public var structureName: String
    public var inspectorName: String
    public var createdAt: Date
    public var updatedAt: Date
    public var note: String
    /// この案件で計測したいひび割れ幅（mm）。撮影ガイドのしきい値になる。
    public var targetCrackWidthMM: Double
    /// この案件に適用する区分しきい値（点検要領に合わせて差し替える）
    public var gradeThresholds: CrackGrade.Thresholds
    public var sessions: [CaptureSession]

    public init(
        id: UUID = UUID(),
        name: String,
        structureName: String = "",
        inspectorName: String = "",
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        note: String = "",
        targetCrackWidthMM: Double = 0.2,
        gradeThresholds: CrackGrade.Thresholds = .default,
        sessions: [CaptureSession] = []
    ) {
        self.id = id
        self.name = name
        self.structureName = structureName
        self.inspectorName = inspectorName
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.note = note
        self.targetCrackWidthMM = targetCrackWidthMM
        self.gradeThresholds = gradeThresholds
        self.sessions = sessions
    }

    public var allCracks: [CrackRecord] {
        sessions.flatMap(\.cracks)
    }
}

/// 1回の撮影（1つの部位をまとめて撮った単位）。
public struct CaptureSession: Codable, Identifiable, Sendable, Hashable {
    public var id: UUID
    /// 部材名（例: 壁高欄 内側 STA.12+340）
    public var memberName: String
    public var startedAt: Date
    public var frameCount: Int
    /// 撮影範囲のカバー率 0...1
    public var coverageRatio: Double
    /// Object Capture で生成した USDZ の相対パス
    public var modelRelativePath: String?
    public var cracks: [CrackRecord]

    public init(
        id: UUID = UUID(),
        memberName: String = "",
        startedAt: Date = Date(),
        frameCount: Int = 0,
        coverageRatio: Double = 0,
        modelRelativePath: String? = nil,
        cracks: [CrackRecord] = []
    ) {
        self.id = id
        self.memberName = memberName
        self.startedAt = startedAt
        self.frameCount = frameCount
        self.coverageRatio = coverageRatio
        self.modelRelativePath = modelRelativePath
        self.cracks = cracks
    }
}

/// 1本のひび割れの記録。
public struct CrackRecord: Codable, Identifiable, Sendable, Hashable {
    public var id: UUID
    /// 図面・帳票で使う通し番号（例: C-001）
    public var label: String
    public var measuredAt: Date
    public var maxWidthMM: Double
    public var meanWidthMM: Double
    public var lengthMM: Double
    /// 計測時の GSD（mm/px）
    public var millimetersPerPixel: Double
    /// 撮影距離（m）
    public var distance: Double
    /// 入射角（度）
    public var incidenceAngleDegrees: Double
    public var confidence: Double
    public var isResolutionSufficient: Bool
    /// 構造物ローカル（ARワールド）座標での代表位置（m）
    public var worldPosition: Vec3?
    /// 芯線の画素座標（オーバーレイ再描画用）
    public var centerlinePixels: [Vec2]
    /// 幅の測点（帳票の詳細表用）
    public var widthSamplesMM: [Double]
    /// 保存された写真の相対パス
    public var photoRelativePath: String?
    public var note: String
    /// 手入力で上書きした場合の値（クラックスケールで実測した値など）
    public var manualWidthMM: Double?

    public init(
        id: UUID = UUID(),
        label: String,
        measuredAt: Date = Date(),
        maxWidthMM: Double,
        meanWidthMM: Double,
        lengthMM: Double,
        millimetersPerPixel: Double,
        distance: Double,
        incidenceAngleDegrees: Double,
        confidence: Double,
        isResolutionSufficient: Bool,
        worldPosition: Vec3? = nil,
        centerlinePixels: [Vec2] = [],
        widthSamplesMM: [Double] = [],
        photoRelativePath: String? = nil,
        note: String = "",
        manualWidthMM: Double? = nil
    ) {
        self.id = id
        self.label = label
        self.measuredAt = measuredAt
        self.maxWidthMM = maxWidthMM
        self.meanWidthMM = meanWidthMM
        self.lengthMM = lengthMM
        self.millimetersPerPixel = millimetersPerPixel
        self.distance = distance
        self.incidenceAngleDegrees = incidenceAngleDegrees
        self.confidence = confidence
        self.isResolutionSufficient = isResolutionSufficient
        self.worldPosition = worldPosition
        self.centerlinePixels = centerlinePixels
        self.widthSamplesMM = widthSamplesMM
        self.photoRelativePath = photoRelativePath
        self.note = note
        self.manualWidthMM = manualWidthMM
    }

    /// 帳票に載せる幅（手入力があればそちらを優先）。
    public var reportedWidthMM: Double { manualWidthMM ?? maxWidthMM }

    public func grade(using thresholds: CrackGrade.Thresholds = .default) -> CrackGrade {
        CrackGrade.grade(forWidthMM: reportedWidthMM, thresholds: thresholds)
    }
}

extension CrackRecord {
    /// 計測結果から記録を作る。
    public init(
        label: String,
        measurement: CrackMeasurement,
        scale: SurfaceScale,
        photoRelativePath: String? = nil
    ) {
        // 代表点は芯線の中央。撮影距離・入射角はここの値を記録する。
        let representative = measurement.centerline.isEmpty
            ? Vec2(Double(scale.intrinsics.imageWidth) / 2, Double(scale.intrinsics.imageHeight) / 2)
            : measurement.centerline[measurement.centerline.count / 2]
        self.init(
            id: measurement.id,
            label: label,
            maxWidthMM: measurement.maxWidthMM,
            meanWidthMM: measurement.meanWidthMM,
            lengthMM: measurement.lengthMM,
            millimetersPerPixel: measurement.millimetersPerPixel,
            distance: scale.distance(at: representative) ?? 0,
            incidenceAngleDegrees: scale.incidenceAngleDegrees(at: representative) ?? 0,
            confidence: measurement.confidence,
            isResolutionSufficient: measurement.isResolutionSufficient,
            worldPosition: scale.worldPoint(at: representative),
            centerlinePixels: measurement.centerline,
            widthSamplesMM: measurement.samples.map(\.widthMM),
            photoRelativePath: photoRelativePath
        )
    }
}
