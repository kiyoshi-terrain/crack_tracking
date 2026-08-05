import Foundation

/// マルチスケール・ヘッセ行列によるリッジ（線状構造）検出。
///
/// Steger の線検出および Frangi の血管強調と同系統の手法です。
/// ひび割れは「周囲より暗い細い線」なので、ガウシアン2階微分の
/// 最大固有値が正で大きい場所が候補になります。
///
/// 複数の σ で評価して最大応答を採ることで、髪の毛のような細いひび割れから
/// 数 mm 幅の開口部まで同じパイプラインで拾えます。
public struct RidgeField: Sendable {
    public let width: Int
    public let height: Int
    /// リッジ応答の強さ（大きいほど線らしい）
    public var strength: [Float]
    /// 線を横切る方向の単位ベクトル（幅を測る方向）
    public var normalX: [Float]
    public var normalY: [Float]
    /// 最大応答を与えた σ。おおよその線幅の目安になる。
    public var scale: [Float]

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
        let n = max(0, width * height)
        self.strength = [Float](repeating: 0, count: n)
        self.normalX = [Float](repeating: 0, count: n)
        self.normalY = [Float](repeating: 0, count: n)
        self.scale = [Float](repeating: 0, count: n)
    }

    public func strengthImage() -> GrayImage {
        GrayImage(width: width, height: height, pixels: strength)
    }

    /// 線を横切る方向（単位ベクトル）。
    public func normal(x: Int, y: Int) -> Vec2 {
        let i = y * width + x
        return Vec2(Double(normalX[i]), Double(normalY[i]))
    }

    /// 線に沿う方向（単位ベクトル）。
    public func tangent(x: Int, y: Int) -> Vec2 {
        normal(x: x, y: y).perpendicular
    }

    public func strengthValue(x: Int, y: Int) -> Float {
        guard x >= 0, y >= 0, x < width, y < height else { return 0 }
        return strength[y * width + x]
    }
}

public enum RidgeDetector {

    /// 探す線の明暗。
    ///
    /// **入力画像の極性に必ず合わせてください。** 間違えると芯線ではなく
    /// 線の両脇（曲率の符号が反転する位置）に応答してしまい、
    /// 1本のひび割れが 2本に割れて数 px ずれた位置に出ます。
    ///
    /// - `darkLine`: 明るい背景に暗い線（撮ったままの画像）
    /// - `brightLine`: 暗い背景に明るい線（`ImageFilters.darkTopHat` の出力）
    public enum Polarity: Sendable {
        case darkLine
        case brightLine
    }

    /// 既定の解析スケール（px）。σ ≒ 線幅/2 程度が最も強く応答します。
    public static let defaultScales: [Double] = [1.0, 1.5, 2.2, 3.2, 4.5]

    /// 線状構造のリッジ応答を計算する。
    ///
    /// - Parameters:
    ///   - image: グレースケール画像（0...1）
    ///   - scales: 解析する σ の配列
    ///   - polarity: 探す線の明暗。入力画像に合わせること。
    public static func compute(
        _ image: GrayImage,
        scales: [Double] = defaultScales,
        polarity: Polarity = .darkLine
    ) -> RidgeField {
        var field = RidgeField(width: image.width, height: image.height)
        guard !image.isEmpty else { return field }

        for sigma in scales {
            let (ixx, ixy, iyy) = hessian(image, sigma: sigma)
            // γ 正規化（γ=1）: σ² を掛けてスケール間で応答を比較可能にする。
            let norm = Float(sigma * sigma)

            for i in 0..<field.strength.count {
                let a = ixx.pixels[i] * norm
                let b = ixy.pixels[i] * norm
                let c = iyy.pixels[i] * norm

                // 2x2 対称行列の固有値（閉形式）
                let mean = (a + c) / 2
                let diff = (a - c) / 2
                let disc = (diff * diff + b * b).squareRoot()
                let lambda1 = mean + disc   // 絶対値が大きい方（|λ1| >= |λ2| とは限らないので下で判定）
                let lambda2 = mean - disc

                // 絶対値の大きい固有値が「線を横切る方向」の曲率。
                // 暗い線ならこれが正、明るい線なら負になる。
                let major = abs(lambda1) >= abs(lambda2) ? lambda1 : lambda2
                let minor = abs(lambda1) >= abs(lambda2) ? lambda2 : lambda1
                let signedStrength = polarity == .darkLine ? major : -major
                guard signedStrength > 0 else { continue }

                // 異方性: 線状なら |minor| << |major|。塊状のノイズを抑制する。
                let anisotropy = 1 - min(1, abs(minor) / max(abs(major), 1e-8))
                let response = signedStrength * anisotropy

                if response > field.strength[i] {
                    field.strength[i] = response
                    field.scale[i] = Float(sigma)

                    // major に対応する固有ベクトル = 線を横切る方向。
                    // b ≒ 0 のときは行列が対角なので固有ベクトルは軸に一致する。
                    // 一般式 (b, λ-a) をそのまま使うと 0/0 になって向きが暴れるため分ける。
                    let nx: Float
                    let ny: Float
                    if abs(b) <= 1e-9 {
                        if abs(a) >= abs(c) {
                            nx = 1
                            ny = 0
                        } else {
                            nx = 0
                            ny = 1
                        }
                    } else {
                        nx = b
                        ny = major - a
                    }
                    let len = max((nx * nx + ny * ny).squareRoot(), 1e-12)
                    field.normalX[i] = nx / len
                    field.normalY[i] = ny / len
                }
            }
        }
        return field
    }

    /// ガウシアン2階微分によるヘッセ行列成分。
    static func hessian(_ image: GrayImage, sigma: Double) -> (ixx: GrayImage, ixy: GrayImage, iyy: GrayImage) {
        let g = ImageFilters.gaussianKernel(sigma: sigma)
        let d1 = gaussianDerivativeKernel(sigma: sigma, order: 1)
        let d2 = gaussianDerivativeKernel(sigma: sigma, order: 2)

        let ixx = ImageFilters.convolveSeparable(image, horizontal: d2, vertical: g)
        let iyy = ImageFilters.convolveSeparable(image, horizontal: g, vertical: d2)
        let ixy = ImageFilters.convolveSeparable(image, horizontal: d1, vertical: d1)
        return (ixx, ixy, iyy)
    }

    /// ガウシアン微分カーネル（1次元）。
    static func gaussianDerivativeKernel(sigma: Double, order: Int) -> [Float] {
        let radius = max(1, Int(ceil(sigma * 3)))
        var kernel = [Float](repeating: 0, count: radius * 2 + 1)
        let s2 = sigma * sigma
        let norm = 1.0 / (sqrt(2 * Double.pi) * sigma)
        for i in -radius...radius {
            let x = Double(i)
            let g = norm * exp(-x * x / (2 * s2))
            let v: Double
            switch order {
            case 0: v = g
            case 1: v = -x / s2 * g
            default: v = (x * x - s2) / (s2 * s2) * g
            }
            kernel[i + radius] = Float(v)
        }
        // 0次のみ総和を1に正規化（微分カーネルは総和0が正しい）
        if order == 0 {
            let sum = kernel.reduce(0, +)
            if abs(sum) > 1e-8 {
                for i in 0..<kernel.count { kernel[i] /= sum }
            }
        }
        return kernel
    }
}
