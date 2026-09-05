import Foundation

/// 画像1枚からひび割れを検出し、実寸で計測するパイプライン。
///
/// ```
/// グレースケール
///   → （縮小: 検出用）
///   → 背景除去（暗トップハット）
///   → マルチスケール・リッジ検出
///   → 非極大抑制 + ヒステリシス
///   → 細線化 → ポリライン化
///   → 芯線を原寸へ戻す
///   → 断面プロファイルによる幅計測（**原寸**の輝度を使用）
///   → LiDAR 平面によるスケール適用
/// ```
///
/// **検出は縮小画像・計測は原寸。** 近接では 1mm の亀裂が 20px、3mm なら 60px に
/// 写るので、等倍で追うと σ=30 級のカーネルが要って数十秒かかる。芯線の位置なら
/// 縮小画像で十分（数 px ずれても断面の対称性で中心を取り直す）で、幅だけは
/// 原寸の断面から測る。`downsampleFactor` はその縮小率。
public struct CrackDetector: Sendable {

    public struct Options: Sendable {
        /// 背景推定に使うブラー半径（**原寸 px**）。想定する最大ひび割れ幅の 5〜10 倍程度。
        public var backgroundRadiusPx: Int
        /// リッジ検出のスケール σ（**原寸 px**）。検出時に縮小率で割る。
        public var ridgeScales: [Double]
        public var threshold: RidgeThresholder.Options
        /// 芯線抽出のパラメータ（**検出画像の px**）
        public var tracing: PolylineTracer.Options
        public var width: WidthEstimator.Options
        /// 検出に使う縮小率。1 で等倍。幅の計測は縮小率に関わらず原寸で行う。
        public var downsampleFactor: Int
        /// 返すひび割れの最大本数（長い順）
        public var maxCracks: Int

        public init(
            backgroundRadiusPx: Int = 24,
            ridgeScales: [Double] = RidgeDetector.defaultScales,
            threshold: RidgeThresholder.Options = .default,
            tracing: PolylineTracer.Options = .default,
            width: WidthEstimator.Options = .default,
            downsampleFactor: Int = 1,
            maxCracks: Int = 24
        ) {
            self.backgroundRadiusPx = backgroundRadiusPx
            self.ridgeScales = ridgeScales
            self.threshold = threshold
            self.tracing = tracing
            self.width = width
            self.downsampleFactor = downsampleFactor
            self.maxCracks = maxCracks
        }

        public static let `default` = Options()

        /// 遠景・広範囲のスクリーニング用（速度優先）。
        public static let survey: Options = {
            var o = Options()
            o.downsampleFactor = 2
            // 原寸 px。検出画像では [1.0, 1.8, 3.0]
            o.ridgeScales = [2.0, 3.6, 6.0]
            o.tracing.minBranchLengthPx = 20
            o.maxCracks = 40
            return o
        }()
    }

    public struct Result: Sendable {
        /// 芯線は**原寸**の画素座標
        public let measurements: [CrackMeasurement]
        /// 検出マスク（デバッグ表示・オーバーレイ用）。**検出画像**の解像度
        public let skeleton: BinaryMask
        /// リッジ応答（デバッグ表示用）。**検出画像**の解像度
        public let ridgeStrength: GrayImage
        /// 検出に使った縮小率
        public let detectionFactor: Int
    }

    public var options: Options

    public init(options: Options = .default) {
        self.options = options
    }

    /// 画像全体からひび割れを検出して計測する。
    public func detect(in image: GrayImage, scale: SurfaceScale) -> Result {
        let prepared = prepare(image)
        // 強調画像は「背景よりどれだけ暗いか」なので、ひび割れは明るい線になる。
        let field = RidgeDetector.compute(
            prepared.enhanced,
            scales: prepared.detectionScales(options.ridgeScales),
            polarity: .brightLine
        )
        var mask = RidgeThresholder.mask(from: field, options: options.threshold)
        mask = Skeletonizer.thin(mask)
        let polylines = PolylineTracer.trace(mask, options: options.tracing)
        let measurements = measureAll(
            polylines: polylines,
            field: field,
            prepared: prepared,
            scale: scale
        )
        return Result(
            measurements: measurements,
            skeleton: mask,
            ridgeStrength: field.strengthImage(),
            detectionFactor: prepared.factor
        )
    }

    /// 画面タップ位置を含む1本だけを計測する（オペレータが対象を指定するモード）。
    ///
    /// - Parameters:
    ///   - point: タップ位置（**原寸** px）
    ///   - searchRadiusPx: この半径（**原寸** px）以内で最も近い芯線を採る。
    ///     画面上の指の大きさを画像の px に換算して渡す（48MP では 24px は
    ///     画面の 0.3% しかなく、ほぼ必ず「見つかりません」になる）。
    public func measureCrack(
        in image: GrayImage,
        near point: Vec2,
        scale: SurfaceScale,
        searchRadiusPx: Int = 24
    ) -> CrackMeasurement? {
        let prepared = prepare(image)
        let scaledPoint = prepared.toDetection(point)
        let field = RidgeDetector.compute(
            prepared.enhanced,
            scales: prepared.detectionScales(options.ridgeScales),
            polarity: .brightLine
        )
        var mask = RidgeThresholder.mask(from: field, options: options.threshold)
        mask = Skeletonizer.thin(mask)
        guard let component = RidgeThresholder.component(
            in: mask,
            containing: scaledPoint,
            searchRadius: max(1, searchRadiusPx / prepared.factor)
        ) else { return nil }

        let polylines = PolylineTracer.trace(component, options: options.tracing)
        let measurements = measureAll(
            polylines: polylines,
            field: field,
            prepared: prepared,
            scale: scale
        )
        // タップ点に最も近いものを返す（芯線は原寸座標なので原寸の点と比べる）
        return measurements.min { a, b in
            minDistance(from: point, to: a.centerline) < minDistance(from: point, to: b.centerline)
        }
    }

    // MARK: - 内部

    struct Prepared {
        /// 検出に使う強調画像（縮小済み）
        let enhanced: GrayImage
        /// 幅計測に使う輝度画像（**原寸**。背景除去はしない）
        let luminance: GrayImage
        let factor: Int

        /// 原寸 σ を検出画像の σ へ。細すぎるカーネルは 0.8 で止める
        func detectionScales(_ scales: [Double]) -> [Double] {
            guard factor > 1 else { return scales }
            var out: [Double] = []
            for s in scales {
                let d = max(0.8, s / Double(factor))
                if !out.contains(where: { abs($0 - d) < 1e-9 }) { out.append(d) }
            }
            return out
        }

        /// 原寸座標 → 検出画像座標
        func toDetection(_ p: Vec2) -> Vec2 {
            guard factor > 1 else { return p }
            let f = Double(factor)
            return Vec2((p.x + 0.5) / f - 0.5, (p.y + 0.5) / f - 0.5)
        }

        /// 検出画像座標 → 原寸座標（縮小ブロックの中心へ）
        func toFullResolution(_ p: Vec2) -> Vec2 {
            guard factor > 1 else { return p }
            let f = Double(factor)
            return Vec2((p.x + 0.5) * f - 0.5, (p.y + 0.5) * f - 0.5)
        }
    }

    func prepare(_ image: GrayImage) -> Prepared {
        let factor = max(1, options.downsampleFactor)
        let detection = factor > 1 ? image.downsampled(by: factor) : image
        let radius = max(4, options.backgroundRadiusPx / factor)
        let enhanced = ImageFilters.darkTopHat(detection, radius: radius)
        return Prepared(enhanced: enhanced, luminance: image, factor: factor)
    }

    func measureAll(
        polylines: [[Vec2]],
        field: RidgeField,
        prepared: Prepared,
        scale: SurfaceScale
    ) -> [CrackMeasurement] {
        let estimator = WidthEstimator(options: options.width)
        var results: [CrackMeasurement] = []

        for polyline in polylines.prefix(options.maxCracks) {
            // 幅の当たりは検出画像の σ から。原寸へ戻す
            let hint = widthHint(for: polyline, field: field) * Double(prepared.factor)
            let fullResolution = polyline.map(prepared.toFullResolution)
            if let m = estimator.measure(
                image: prepared.luminance,
                centerline: fullResolution,
                scale: scale,
                expectedWidthHint: hint
            ) {
                results.append(m)
            }
        }
        results.sort { $0.maxWidthMM > $1.maxWidthMM }
        return results
    }

    /// リッジ検出時の σ から幅の当たりを付ける（断面の探索範囲を決めるため）。
    /// 戻り値は**検出画像**の px。
    func widthHint(for polyline: [Vec2], field: RidgeField) -> Double {
        var total = 0.0
        var count = 0
        for p in polyline {
            let x = Int(p.x.rounded()), y = Int(p.y.rounded())
            guard x >= 0, y >= 0, x < field.width, y < field.height else { continue }
            let s = Double(field.scale[y * field.width + x])
            if s > 0 {
                total += s
                count += 1
            }
        }
        guard count > 0 else { return 2.0 }
        // σ ≒ 線幅 / 2
        return max(1.0, (total / Double(count)) * 2.0)
    }

    func minDistance(from point: Vec2, to polyline: [Vec2]) -> Double {
        polyline.map { $0.distance(to: point) }.min() ?? .infinity
    }
}
