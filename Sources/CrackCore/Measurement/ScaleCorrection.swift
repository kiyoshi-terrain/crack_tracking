import Foundation

/// 既知の長さで縦尺を合わせる（スケールバー校正）。
///
/// LiDAR の距離は 0.3 m で 3〜10% 揺れる（ゲージシート 6 枚の校正で、静止画ごとの
/// 倍率が 1.03〜1.095）。幅は距離に比例するので、2mm の亀裂ならそれだけで ±0.1mm。
/// 写真測量の常道どおり、亀裂の横に既知の長さ（100mm の目印を付けたテープなど）を
/// 写し込み、その静止画の縦尺をそれで合わせる。LiDAR の偏りもばらつきも、
/// その静止画の中では消える。
///
/// 平面を法線方向に k 倍の距離へ動かすと、視線との交点は原点からの相似拡大になり、
/// 面上の距離はすべて k 倍になる。幅・延長・mm/px を個別に掛け直すより、平面を
/// 動かして測り直す方が一貫する（以後の計測も自動で補正後の縦尺になる）。
public enum ScaleCorrection {

    /// 面上の距離が `factor` 倍になるように平面を動かす。
    public static func plane(_ plane: Plane, scaledBy factor: Double) -> Plane {
        Plane(normal: plane.normal, distance: plane.distance * factor)
    }

    /// 測った長さと既知の長さから倍率。どちらかが 0 以下なら nil。
    public static func factor(measuredMM: Double, knownMM: Double) -> Double? {
        guard measuredMM.isFinite, knownMM.isFinite, measuredMM > 0, knownMM > 0 else { return nil }
        return knownMM / measuredMM
    }
}

extension CrackMeasurement {
    /// 縦尺を `factor` 倍にした写し。幅・延長・mm/px が変わり、芯線の画素座標は変わらない。
    /// 既に測った候補に、後から当てた縦尺補正を反映するのに使う。
    public func scaled(by factor: Double) -> CrackMeasurement {
        guard factor.isFinite, factor > 0, factor != 1 else { return self }
        let scaledSamples = samples.map { s in
            WidthSample(
                position: s.position,
                normal: s.normal,
                widthPixels: s.widthPixels,
                widthMM: s.widthMM * factor,
                contrast: s.contrast,
                millimetersPerPixel: s.millimetersPerPixel * factor,
                confidence: s.confidence
            )
        }
        return CrackMeasurement(
            id: id,
            centerline: centerline,
            samples: scaledSamples,
            lengthMM: lengthMM * factor,
            maxWidthMM: maxWidthMM * factor,
            meanWidthMM: meanWidthMM * factor,
            millimetersPerPixel: millimetersPerPixel * factor,
            // 画素数は変わらないので、分解能の充足も変わらない
            isResolutionSufficient: isResolutionSufficient,
            confidence: confidence
        )
    }
}
