import Foundation
@testable import CrackCore

/// 既知の幅を持つ人工ひび割れ画像を生成する。
///
/// 幅計測の正しさを「答えが分かっている入力」で確認するために使います。
enum SyntheticImage {

    /// 指定の直線状ひび割れを描いた画像を返す。
    ///
    /// - Parameters:
    ///   - width/height: 画像サイズ
    ///   - crackWidthPx: ひび割れの真幅（px）
    ///   - angleDegrees: ひび割れの向き（0 = 垂直線）
    ///   - background: 背景輝度
    ///   - crackValue: ひび割れ内部の輝度
    ///   - blurSigma: レンズボケの模擬（0 でボケなし）
    ///   - illuminationGradient: 左右の照明ムラの強さ
    static func straightCrack(
        width: Int = 128,
        height: Int = 128,
        crackWidthPx: Double,
        angleDegrees: Double = 0,
        background: Float = 0.85,
        crackValue: Float = 0.30,
        blurSigma: Double = 0,
        illuminationGradient: Float = 0,
        supersample: Int = 4
    ) -> GrayImage {
        var image = GrayImage(width: width, height: height, repeating: background)
        let theta = angleDegrees * .pi / 180
        // 線の方向（単位ベクトル）と法線
        let direction = Vec2(sin(theta), cos(theta))
        let normal = direction.perpendicular
        let center = Vec2(Double(width - 1) / 2, Double(height - 1) / 2)
        let half = crackWidthPx / 2
        let sub = Double(supersample)

        for y in 0..<height {
            for x in 0..<width {
                var inside = 0
                for sy in 0..<supersample {
                    for sx in 0..<supersample {
                        let px = Double(x) + (Double(sx) + 0.5) / sub - 0.5
                        let py = Double(y) + (Double(sy) + 0.5) / sub - 0.5
                        let d = abs((Vec2(px, py) - center).dot(normal))
                        if d <= half { inside += 1 }
                    }
                }
                let coverage = Float(inside) / Float(supersample * supersample)
                image[x, y] = background * (1 - coverage) + crackValue * coverage
            }
        }

        if illuminationGradient != 0 {
            for y in 0..<height {
                for x in 0..<width {
                    let t = Float(x) / Float(max(1, width - 1))
                    image[x, y] *= 1 + illuminationGradient * (t - 0.5)
                }
            }
        }

        if blurSigma > 0 {
            image = ImageFilters.gaussianBlur(image, sigma: blurSigma)
        }
        return image
    }

    /// 正対・既知 GSD のスケール換算器。
    static func frontoParallelScale(
        imageWidth: Int,
        imageHeight: Int,
        focalPixels: Double = 1000,
        distance: Double = 1.0
    ) -> SurfaceScale {
        let intrinsics = CameraIntrinsics(
            fx: focalPixels,
            fy: focalPixels,
            cx: Double(imageWidth - 1) / 2,
            cy: Double(imageHeight - 1) / 2,
            imageWidth: imageWidth,
            imageHeight: imageHeight
        )
        return SurfaceScale.frontoParallel(intrinsics: intrinsics, depth: distance)
    }
}
