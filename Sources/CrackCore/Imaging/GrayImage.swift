import Foundation

/// 32bit float のグレースケール画像。値域は 0...1 を想定。
public struct GrayImage: Sendable {
    public let width: Int
    public let height: Int
    public var pixels: [Float]

    public init(width: Int, height: Int, pixels: [Float]) {
        precondition(pixels.count == width * height, "pixel count mismatch")
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    public init(width: Int, height: Int, repeating value: Float = 0) {
        self.width = width
        self.height = height
        self.pixels = [Float](repeating: value, count: max(0, width * height))
    }

    public var count: Int { width * height }
    public var isEmpty: Bool { width <= 0 || height <= 0 }

    @inlinable
    public subscript(x: Int, y: Int) -> Float {
        get { pixels[y * width + x] }
        set { pixels[y * width + x] = newValue }
    }

    /// 範囲外を端でクランプして読む。
    @inlinable
    public func clamped(_ x: Int, _ y: Int) -> Float {
        let cx = min(max(x, 0), width - 1)
        let cy = min(max(y, 0), height - 1)
        return pixels[cy * width + cx]
    }

    public func contains(_ p: Vec2) -> Bool {
        p.x >= 0 && p.y >= 0 && p.x <= Double(width - 1) && p.y <= Double(height - 1)
    }

    /// バイリニア補間サンプリング。サブピクセルのプロファイル抽出に使う。
    public func sample(at p: Vec2) -> Float {
        sample(x: p.x, y: p.y)
    }

    public func sample(x: Double, y: Double) -> Float {
        let x0 = Int(floor(x)), y0 = Int(floor(y))
        let fx = Float(x - floor(x)), fy = Float(y - floor(y))
        let v00 = clamped(x0, y0)
        let v10 = clamped(x0 + 1, y0)
        let v01 = clamped(x0, y0 + 1)
        let v11 = clamped(x0 + 1, y0 + 1)
        let top = v00 + (v10 - v00) * fx
        let bottom = v01 + (v11 - v01) * fx
        return top + (bottom - top) * fy
    }

    public var minMax: (min: Float, max: Float) {
        guard var lo = pixels.first else { return (0, 0) }
        var hi = lo
        for v in pixels {
            if v < lo { lo = v }
            if v > hi { hi = v }
        }
        return (lo, hi)
    }

    public var mean: Float {
        guard !pixels.isEmpty else { return 0 }
        var sum: Double = 0
        for v in pixels { sum += Double(v) }
        return Float(sum / Double(pixels.count))
    }

    /// 0...1 に線形伸長する。
    public func normalized() -> GrayImage {
        let (lo, hi) = minMax
        let range = hi - lo
        guard range > 1e-8 else { return GrayImage(width: width, height: height, repeating: 0) }
        var out = self
        for i in 0..<out.pixels.count {
            out.pixels[i] = (out.pixels[i] - lo) / range
        }
        return out
    }

    /// 矩形の切り出し（画像外はクランプ）。
    public func cropped(to rect: PixelRect) -> GrayImage {
        let x0 = max(0, rect.x)
        let y0 = max(0, rect.y)
        let x1 = min(width, rect.x + rect.width)
        let y1 = min(height, rect.y + rect.height)
        let w = max(0, x1 - x0)
        let h = max(0, y1 - y0)
        var out = GrayImage(width: w, height: h)
        for y in 0..<h {
            for x in 0..<w {
                out[x, y] = self[x0 + x, y0 + y]
            }
        }
        return out
    }

    /// 単純な面積平均による縮小（整数倍）。前処理の高速化用。
    public func downsampled(by factor: Int) -> GrayImage {
        guard factor > 1 else { return self }
        let w = width / factor
        let h = height / factor
        guard w > 0, h > 0 else { return self }
        var out = GrayImage(width: w, height: h)
        let inv = Float(factor * factor)
        for y in 0..<h {
            for x in 0..<w {
                var sum: Float = 0
                for dy in 0..<factor {
                    for dx in 0..<factor {
                        sum += self[x * factor + dx, y * factor + dy]
                    }
                }
                out[x, y] = sum / inv
            }
        }
        return out
    }
}

/// 整数の画素矩形。
public struct PixelRect: Equatable, Codable, Sendable {
    public var x: Int
    public var y: Int
    public var width: Int
    public var height: Int

    public init(x: Int, y: Int, width: Int, height: Int) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var origin: Vec2 { Vec2(Double(x), Double(y)) }

    /// 中心と半径から作る正方領域。
    public static func centered(at center: Vec2, radius: Int) -> PixelRect {
        PixelRect(
            x: Int(center.x.rounded()) - radius,
            y: Int(center.y.rounded()) - radius,
            width: radius * 2 + 1,
            height: radius * 2 + 1
        )
    }

    public func clamped(toWidth w: Int, height h: Int) -> PixelRect {
        let x0 = max(0, x)
        let y0 = max(0, y)
        let x1 = min(w, x + width)
        let y1 = min(h, y + height)
        return PixelRect(x: x0, y: y0, width: max(0, x1 - x0), height: max(0, y1 - y0))
    }
}

/// 2値マスク。
public struct BinaryMask: Sendable {
    public let width: Int
    public let height: Int
    public var values: [Bool]

    public init(width: Int, height: Int, values: [Bool]) {
        precondition(values.count == width * height)
        self.width = width
        self.height = height
        self.values = values
    }

    public init(width: Int, height: Int, repeating value: Bool = false) {
        self.width = width
        self.height = height
        self.values = [Bool](repeating: value, count: max(0, width * height))
    }

    @inlinable
    public subscript(x: Int, y: Int) -> Bool {
        get { values[y * width + x] }
        set { values[y * width + x] = newValue }
    }

    @inlinable
    public func at(_ x: Int, _ y: Int) -> Bool {
        guard x >= 0, y >= 0, x < width, y < height else { return false }
        return values[y * width + x]
    }

    public var trueCount: Int { values.reduce(0) { $0 + ($1 ? 1 : 0) } }
}
