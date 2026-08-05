import Foundation

/// ひび割れ抽出の前処理に使う基本フィルタ群。
public enum ImageFilters {

    // MARK: - 平滑化

    /// 分離可能ボックスブラー（積分和による O(N)）。
    public static func boxBlur(_ image: GrayImage, radius: Int) -> GrayImage {
        guard radius > 0, !image.isEmpty else { return image }
        let w = image.width, h = image.height
        var tmp = GrayImage(width: w, height: h)
        let window = Float(radius * 2 + 1)

        // 水平方向
        for y in 0..<h {
            var sum: Float = 0
            for k in -radius...radius { sum += image.clamped(k, y) }
            for x in 0..<w {
                tmp[x, y] = sum / window
                sum += image.clamped(x + radius + 1, y) - image.clamped(x - radius, y)
            }
        }

        // 垂直方向
        var out = GrayImage(width: w, height: h)
        for x in 0..<w {
            var sum: Float = 0
            for k in -radius...radius { sum += tmp.clamped(x, k) }
            for y in 0..<h {
                out[x, y] = sum / window
                sum += tmp.clamped(x, y + radius + 1) - tmp.clamped(x, y - radius)
            }
        }
        return out
    }

    /// ガウシアンカーネル（1次元, 正規化済み）。
    public static func gaussianKernel(sigma: Double) -> [Float] {
        let radius = max(1, Int(ceil(sigma * 3)))
        var kernel = [Float](repeating: 0, count: radius * 2 + 1)
        var sum: Double = 0
        for i in -radius...radius {
            let v = exp(-Double(i * i) / (2 * sigma * sigma))
            kernel[i + radius] = Float(v)
            sum += v
        }
        for i in 0..<kernel.count { kernel[i] /= Float(sum) }
        return kernel
    }

    /// 分離可能ガウシアンブラー。
    public static func gaussianBlur(_ image: GrayImage, sigma: Double) -> GrayImage {
        guard sigma > 0.05, !image.isEmpty else { return image }
        let kernel = gaussianKernel(sigma: sigma)
        return convolveSeparable(image, horizontal: kernel, vertical: kernel)
    }

    /// 水平カーネルと垂直カーネルを別々に適用する。
    public static func convolveSeparable(_ image: GrayImage, horizontal kx: [Float], vertical ky: [Float]) -> GrayImage {
        let w = image.width, h = image.height
        let rx = kx.count / 2
        let ry = ky.count / 2

        var tmp = GrayImage(width: w, height: h)
        for y in 0..<h {
            for x in 0..<w {
                var acc: Float = 0
                for i in 0..<kx.count {
                    acc += kx[i] * image.clamped(x + i - rx, y)
                }
                tmp[x, y] = acc
            }
        }

        var out = GrayImage(width: w, height: h)
        for y in 0..<h {
            for x in 0..<w {
                var acc: Float = 0
                for i in 0..<ky.count {
                    acc += ky[i] * tmp.clamped(x, y + i - ry)
                }
                out[x, y] = acc
            }
        }
        return out
    }

    // MARK: - 背景除去

    /// 暗いトップハット変換（近似）。
    ///
    /// コンクリート壁面は照明ムラ・打ち継ぎ・型枠跡で輝度が大きく変動します。
    /// 大きな半径のブラーを「背景」とみなして差分を取ると、細い暗線だけが残ります。
    /// 出力は「背景よりどれだけ暗いか」（0以上）。
    public static func darkTopHat(_ image: GrayImage, radius: Int) -> GrayImage {
        let background = boxBlur(image, radius: radius)
        var out = GrayImage(width: image.width, height: image.height)
        for i in 0..<image.pixels.count {
            out.pixels[i] = max(0, background.pixels[i] - image.pixels[i])
        }
        return out
    }

    // MARK: - 微分

    /// Sobel 勾配。
    public static func sobel(_ image: GrayImage) -> (gx: GrayImage, gy: GrayImage) {
        let w = image.width, h = image.height
        var gx = GrayImage(width: w, height: h)
        var gy = GrayImage(width: w, height: h)
        for y in 0..<h {
            for x in 0..<w {
                let p00 = image.clamped(x - 1, y - 1), p10 = image.clamped(x, y - 1), p20 = image.clamped(x + 1, y - 1)
                let p01 = image.clamped(x - 1, y),                                     p21 = image.clamped(x + 1, y)
                let p02 = image.clamped(x - 1, y + 1), p12 = image.clamped(x, y + 1), p22 = image.clamped(x + 1, y + 1)
                gx[x, y] = (p20 + 2 * p21 + p22) - (p00 + 2 * p01 + p02)
                gy[x, y] = (p02 + 2 * p12 + p22) - (p00 + 2 * p10 + p20)
            }
        }
        return (gx, gy)
    }

    /// ラプラシアンの分散。ピント判定（ブレ・ボケ検出）に使う古典的な指標。
    public static func varianceOfLaplacian(_ image: GrayImage) -> Double {
        let w = image.width, h = image.height
        guard w > 2, h > 2 else { return 0 }
        var sum: Double = 0
        var sumSq: Double = 0
        var n = 0
        for y in 1..<(h - 1) {
            for x in 1..<(w - 1) {
                let lap = Double(
                    4 * image[x, y]
                    - image[x - 1, y] - image[x + 1, y]
                    - image[x, y - 1] - image[x, y + 1]
                )
                sum += lap
                sumSq += lap * lap
                n += 1
            }
        }
        guard n > 0 else { return 0 }
        let mean = sum / Double(n)
        return sumSq / Double(n) - mean * mean
    }

    // MARK: - 統計

    /// 値のパーセンタイル（0...1）。しきい値の自動決定に使う。
    public static func percentile(_ values: [Float], _ q: Double) -> Float {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let idx = Int((Double(sorted.count - 1) * min(max(q, 0), 1)).rounded())
        return sorted[idx]
    }
}
