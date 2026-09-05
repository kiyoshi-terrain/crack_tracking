import Foundation

/// 「枠内を全部測る」で拾った候補から、亀裂とは考えにくいものを落とす。
///
/// リッジ検出は暗くて細長いものを全部拾う。石材の斑点（ミソ）、目地の縁、影、
/// 机の上ならキーボードの縁まで候補になる（実機で 13 本出た）。亀裂は
/// **幅に比べて十分長い**ので、長さと幅の比で大半を落とせる。
///
/// なぞって測るモードには掛けない。人が指した線は人が責任を持つ。
public struct CandidateFilter: Sendable {
    /// これより短い候補は落とす（mm）。2mm の「亀裂」は亀裂ではない
    public var minLengthMM: Double
    /// 長さが最大幅のこの倍数に満たない候補は落とす。斑点は 1〜3 倍、亀裂は数十倍
    public var minLengthToWidthRatio: Double
    /// 信頼度（コントラスト・分解能・断面の対称性の合成）の下限
    public var minConfidence: Double

    public init(minLengthMM: Double = 10, minLengthToWidthRatio: Double = 8, minConfidence: Double = 0.4) {
        self.minLengthMM = minLengthMM
        self.minLengthToWidthRatio = minLengthToWidthRatio
        self.minConfidence = minConfidence
    }

    public static let `default` = CandidateFilter()
    /// 何も落とさない
    public static let none = CandidateFilter(minLengthMM: 0, minLengthToWidthRatio: 0, minConfidence: 0)

    /// 落とす理由。通れば nil
    public func rejectionReason(for m: CrackMeasurement) -> String? {
        if m.lengthMM < minLengthMM {
            return String(format: "短すぎる（%.0f mm）", m.lengthMM)
        }
        if m.maxWidthMM > 0, m.lengthMM < m.maxWidthMM * minLengthToWidthRatio {
            return String(format: "幅に対して短い（長さ %.0f mm・幅 %.2f mm）", m.lengthMM, m.maxWidthMM)
        }
        if m.confidence < minConfidence {
            return String(format: "信頼度が低い（%.0f%%）", m.confidence * 100)
        }
        return nil
    }

    public func passes(_ m: CrackMeasurement) -> Bool {
        rejectionReason(for: m) == nil
    }

    public func apply(_ measurements: [CrackMeasurement]) -> [CrackMeasurement] {
        measurements.filter(passes)
    }
}
