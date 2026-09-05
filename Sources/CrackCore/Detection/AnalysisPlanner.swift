import Foundation

/// 「目標幅がこの分解能で何 px に写るか」から、検出のパラメータと解析範囲を決める。
///
/// ## なぜ要るか
///
/// 近接（0.3m・48MP）では 1mm の亀裂が 20px、3mm なら 60px に写る。
/// リッジ検出は σ ≒ 線幅/2 で最も強く応答するので、幅広の亀裂を等倍で追うと
/// σ=30 級のガウシアン微分が必要になり、1600px 角でも数秒〜数十秒かかる。
/// 一方、検出だけなら縮小画像で足りる（芯線の位置が数 px ずれても、幅は
/// 原寸の断面から測り直すので精度は落ちない）。
///
/// そこで **検出は縮小画像・計測は原寸** に分ける。ここはその縮小率と、
/// 縮小率に応じた解析範囲の上限を決めるだけの純粋ロジック。
///
/// ## 目標幅の意味
///
/// `targetWidthMM` は「測りたい幅の級」。検出はこの幅の 0.8〜4 倍程度に
/// 合わせて調整される。細い髪の毛のような亀裂と数 mm の開口を同時に狙うと
/// どちらかを取り逃すので、案件ごとに級を選ぶ。
public enum AnalysisPlanner {

    /// 検出画像上で目標幅を何 px にしたいか。σ 列 [0.4, 0.7, 1.2, 2.0]×幅 が
    /// 実用的なカーネル長（σ ≤ 8）に収まり、かつ 2px 未満の線にならない値。
    public static let preferredDetectionWidthPx: Double = 4.0

    /// 検出画像の一辺の上限（px）。これを超える範囲は解析しない
    /// （縮小率 1 なら原寸でこの一辺。σ 最大 8 の 4 スケールで 2〜3 秒が目安）。
    public static let maxDetectionSide: Int = 1800

    /// 目標幅が原寸で何 px かから、検出に使う縮小率を決める。
    ///
    /// 目標幅が 4px なら等倍、20px なら 5 分の 1。1 未満にはならない。
    public static func detectionFactor(targetWidthPx: Double) -> Int {
        guard targetWidthPx.isFinite, targetWidthPx > 0 else { return 1 }
        return max(1, Int((targetWidthPx / preferredDetectionWidthPx).rounded(.down)))
    }

    /// 目標幅（mm）と分解能（mm/px）から原寸の目標幅（px）。
    public static func targetWidthPx(targetWidthMM: Double, millimetersPerPixel: Double) -> Double {
        guard millimetersPerPixel > 0 else { return preferredDetectionWidthPx }
        return targetWidthMM / millimetersPerPixel
    }

    /// 原寸で解析できる一辺の上限。縮小率 × 検出画像の上限。
    public static func maxAnalysisSide(factor: Int, maxDetectionSide: Int = maxDetectionSide) -> Int {
        max(1, factor) * maxDetectionSide
    }

    /// 解析範囲を上限に収める。中心を保って縮める（縮小ではなくトリミング）。
    ///
    /// 黙って切ると「枠に入れたのに検出されない」が起きるので、呼び出し側は
    /// 戻り値の矩形を**画面に描く**こと。
    public static func clampRegion(_ region: PixelRect, maxSide: Int) -> PixelRect {
        var r = region
        if r.width > maxSide {
            r.x += (r.width - maxSide) / 2
            r.width = maxSide
        }
        if r.height > maxSide {
            r.y += (r.height - maxSide) / 2
            r.height = maxSide
        }
        return r
    }

    /// 目標幅（原寸 px）に合わせた検出オプション。
    ///
    /// - ridgeScales は**原寸 px** の σ。`CrackDetector` が縮小率で割る
    /// - 背景推定の半径は目標幅の 8 倍（幅広の開口が背景に吸われないように）
    /// - 断面の探索半径の上限は目標幅の 8 倍（幅の 4 倍の片側長さが要る）
    public static func detectorOptions(
        targetWidthPx: Double,
        base: CrackDetector.Options = .default
    ) -> CrackDetector.Options {
        var options = base
        let t = max(1.0, targetWidthPx)
        options.downsampleFactor = detectionFactor(targetWidthPx: t)
        options.ridgeScales = [
            max(0.8, t * 0.4),
            max(1.0, t * 0.7),
            max(1.4, t * 1.2),
            max(2.0, t * 2.0),
        ]
        options.backgroundRadiusPx = max(12, Int(t * 8))
        options.width.maxProfileRadiusPx = max(base.width.maxProfileRadiusPx, t * 8)
        return options
    }
}
