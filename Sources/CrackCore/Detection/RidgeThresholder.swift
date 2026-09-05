import Foundation

/// リッジ応答を1画素幅の2値マスクに落とす処理。
///
/// 1. 非極大抑制（線を横切る方向で極大でない画素を落とす）
/// 2. ヒステリシスしきい値（強い芯から弱い部分へ連結成分を伸ばす）
///
/// Canny のエッジ検出と同じ考え方ですが、勾配ではなくリッジ方向に対して行います。
public enum RidgeThresholder {

    public struct Options: Sendable {
        /// 強しきい値を決めるパーセンタイル（応答の分布に対して）
        public var highPercentile: Double
        /// 弱しきい値 = 強しきい値 × この係数
        public var lowRatio: Double
        /// 応答の絶対下限。真っ平らな壁で微小ノイズを拾わないための床。
        public var absoluteFloor: Float
        /// 連結成分として残す最小画素数
        public var minComponentPixels: Int

        public init(
            highPercentile: Double = 0.995,
            lowRatio: Double = 0.4,
            absoluteFloor: Float = 0.004,
            minComponentPixels: Int = 12
        ) {
            self.highPercentile = highPercentile
            self.lowRatio = lowRatio
            self.absoluteFloor = absoluteFloor
            self.minComponentPixels = minComponentPixels
        }

        public static let `default` = Options()
    }

    /// - Parameter region: 与えると、この領域の中の応答だけでしきい値を決め、外は捨てる。
    ///   なぞり計測用。画面全体のパーセンタイルだと、回廊の外にもっと強い構造（目地）が
    ///   あるときに亀裂が種を持てず丸ごと消える（合成検証で実際に消えた）。
    public static func mask(from field: RidgeField, options: Options = .default, within region: BinaryMask? = nil) -> BinaryMask {
        var suppressed = nonMaximumSuppression(field)
        if let region {
            precondition(region.width == suppressed.width && region.height == suppressed.height, "領域の寸法が違う")
            for i in 0..<suppressed.pixels.count where !region.values[i] {
                suppressed.pixels[i] = 0
            }
        }
        let high = max(
            options.absoluteFloor,
            ImageFilters.percentile(suppressed.pixels.filter { $0 > 0 }, options.highPercentile)
        )
        let low = max(options.absoluteFloor * 0.5, high * Float(options.lowRatio))
        var mask = hysteresis(suppressed, low: low, high: high)
        mask = removeSmallComponents(mask, minPixels: options.minComponentPixels)
        return mask
    }

    /// 線を横切る方向の隣接2画素より応答が大きい画素だけを残す。
    public static func nonMaximumSuppression(_ field: RidgeField) -> GrayImage {
        var out = GrayImage(width: field.width, height: field.height)
        let strength = field.strengthImage()
        for y in 0..<field.height {
            for x in 0..<field.width {
                let s = field.strengthValue(x: x, y: y)
                guard s > 0 else { continue }
                let n = field.normal(x: x, y: y)
                let px = Double(x), py = Double(y)
                let forward = strength.sample(x: px + n.x, y: py + n.y)
                let backward = strength.sample(x: px - n.x, y: py - n.y)
                if s >= forward && s >= backward {
                    out[x, y] = s
                }
            }
        }
        return out
    }

    /// ヒステリシスしきい値処理。
    public static func hysteresis(_ image: GrayImage, low: Float, high: Float) -> BinaryMask {
        let w = image.width, h = image.height
        var mask = BinaryMask(width: w, height: h)
        var stack: [(Int, Int)] = []

        for y in 0..<h {
            for x in 0..<w where image[x, y] >= high {
                mask[x, y] = true
                stack.append((x, y))
            }
        }

        while let (x, y) = stack.popLast() {
            for dy in -1...1 {
                for dx in -1...1 {
                    if dx == 0 && dy == 0 { continue }
                    let nx = x + dx, ny = y + dy
                    guard nx >= 0, ny >= 0, nx < w, ny < h else { continue }
                    if !mask[nx, ny] && image[nx, ny] >= low {
                        mask[nx, ny] = true
                        stack.append((nx, ny))
                    }
                }
            }
        }
        return mask
    }

    /// 小さすぎる連結成分（点状のノイズ・砂利の陰）を除去する。
    public static func removeSmallComponents(_ mask: BinaryMask, minPixels: Int) -> BinaryMask {
        guard minPixels > 1 else { return mask }
        var out = BinaryMask(width: mask.width, height: mask.height)
        var visited = BinaryMask(width: mask.width, height: mask.height)

        for y in 0..<mask.height {
            for x in 0..<mask.width {
                guard mask[x, y], !visited[x, y] else { continue }
                var component: [(Int, Int)] = []
                var stack = [(x, y)]
                visited[x, y] = true
                while let (cx, cy) = stack.popLast() {
                    component.append((cx, cy))
                    for dy in -1...1 {
                        for dx in -1...1 {
                            if dx == 0 && dy == 0 { continue }
                            let nx = cx + dx, ny = cy + dy
                            guard nx >= 0, ny >= 0, nx < mask.width, ny < mask.height else { continue }
                            if mask[nx, ny] && !visited[nx, ny] {
                                visited[nx, ny] = true
                                stack.append((nx, ny))
                            }
                        }
                    }
                }
                if component.count >= minPixels {
                    for (cx, cy) in component { out[cx, cy] = true }
                }
            }
        }
        return out
    }

    /// 指定座標を含む連結成分だけを抽出する（画面タップで1本だけ測るとき用）。
    public static func component(in mask: BinaryMask, containing seed: Vec2, searchRadius: Int = 12) -> BinaryMask? {
        let sx = Int(seed.x.rounded()), sy = Int(seed.y.rounded())
        var start: (Int, Int)?
        var bestDistance = Int.max

        for dy in -searchRadius...searchRadius {
            for dx in -searchRadius...searchRadius {
                let x = sx + dx, y = sy + dy
                guard x >= 0, y >= 0, x < mask.width, y < mask.height, mask[x, y] else { continue }
                let d = dx * dx + dy * dy
                if d < bestDistance {
                    bestDistance = d
                    start = (x, y)
                }
            }
        }

        guard let origin = start else { return nil }

        var out = BinaryMask(width: mask.width, height: mask.height)
        var stack = [origin]
        out[origin.0, origin.1] = true
        while let (cx, cy) = stack.popLast() {
            for dy in -1...1 {
                for dx in -1...1 {
                    if dx == 0 && dy == 0 { continue }
                    let nx = cx + dx, ny = cy + dy
                    guard nx >= 0, ny >= 0, nx < mask.width, ny < mask.height else { continue }
                    if mask[nx, ny] && !out[nx, ny] {
                        out[nx, ny] = true
                        stack.append((nx, ny))
                    }
                }
            }
        }
        return out
    }
}
