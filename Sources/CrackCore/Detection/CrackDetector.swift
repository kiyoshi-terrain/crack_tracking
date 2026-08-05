import Foundation

/// 画像1枚からひび割れを検出し、実寸で計測するパイプライン。
///
/// ```
/// グレースケール
///   → 背景除去（暗トップハット）
///   → マルチスケール・リッジ検出
///   → 非極大抑制 + ヒステリシス
///   → 細線化 → ポリライン化
///   → 断面プロファイルによる幅計測（元画像の輝度を使用）
///   → LiDAR 平面によるスケール適用
/// ```
public struct CrackDetector: Sendable {

    public struct Options: Sendable {
        /// 背景推定に使うブラー半径（px）。想定する最大ひび割れ幅の 5〜10 倍程度。
        public var backgroundRadiusPx: Int
        /// リッジ検出のスケール
        public var ridgeScales: [Double]
        public var threshold: RidgeThresholder.Options
        public var tracing: PolylineTracer.Options
        public var width: WidthEstimator.Options
        /// 解析前の縮小率。1 で等倍。細いひび割れを測るので既定は等倍。
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
            o.ridgeScales = [1.0, 1.8, 3.0]
            o.tracing.minBranchLengthPx = 20
            o.maxCracks = 40
            return o
        }()
    }

    public struct Result: Sendable {
        public let measurements: [CrackMeasurement]
        /// 検出マスク（デバッグ表示・オーバーレイ用）
        public let skeleton: BinaryMask
        /// リッジ応答（デバッグ表示用）
        public let ridgeStrength: GrayImage
    }

    public var options: Options

    public init(options: Options = .default) {
        self.options = options
    }

    /// 画像全体からひび割れを検出して計測する。
    public func detect(in image: GrayImage, scale: SurfaceScale) -> Result {
        let prepared = prepare(image)
        let field = RidgeDetector.compute(prepared.enhanced, scales: options.ridgeScales)
        var mask = RidgeThresholder.mask(from: field, options: options.threshold)
        mask = Skeletonizer.thin(mask)
        let polylines = PolylineTracer.trace(mask, options: options.tracing)
        let measurements = measureAll(
            polylines: polylines,
            field: field,
            luminance: prepared.luminance,
            scale: prepared.scale(from: scale)
        )
        return Result(measurements: measurements, skeleton: mask, ridgeStrength: field.strengthImage())
    }

    /// 画面タップ位置を含む1本だけを計測する（オペレータが対象を指定するモード）。
    public func measureCrack(
        in image: GrayImage,
        near point: Vec2,
        scale: SurfaceScale,
        searchRadiusPx: Int = 24
    ) -> CrackMeasurement? {
        let prepared = prepare(image)
        let scaledPoint = point / Double(max(1, options.downsampleFactor))
        let field = RidgeDetector.compute(prepared.enhanced, scales: options.ridgeScales)
        var mask = RidgeThresholder.mask(from: field, options: options.threshold)
        mask = Skeletonizer.thin(mask)
        guard let component = RidgeThresholder.component(
            in: mask,
            containing: scaledPoint,
            searchRadius: searchRadiusPx / max(1, options.downsampleFactor)
        ) else { return nil }

        let polylines = PolylineTracer.trace(component, options: options.tracing)
        let measurements = measureAll(
            polylines: polylines,
            field: field,
            luminance: prepared.luminance,
            scale: prepared.scale(from: scale)
        )
        // タップ点に最も近いものを返す
        return measurements.min { a, b in
            minDistance(from: scaledPoint, to: a.centerline) < minDistance(from: scaledPoint, to: b.centerline)
        }
    }

    // MARK: - 内部

    struct Prepared {
        /// 検出に使う強調画像
        let enhanced: GrayImage
        /// 幅計測に使う輝度画像（縮小のみ適用、背景除去はしない）
        let luminance: GrayImage
        let factor: Int

        func scale(from original: SurfaceScale) -> SurfaceScale {
            guard factor > 1 else { return original }
            return SurfaceScale(
                intrinsics: original.intrinsics.scaled(
                    toWidth: luminance.width,
                    height: luminance.height
                ),
                plane: original.plane
            )
        }
    }

    func prepare(_ image: GrayImage) -> Prepared {
        let factor = max(1, options.downsampleFactor)
        let luminance = factor > 1 ? image.downsampled(by: factor) : image
        let radius = max(4, options.backgroundRadiusPx / factor)
        let enhanced = ImageFilters.darkTopHat(luminance, radius: radius)
        return Prepared(enhanced: enhanced, luminance: luminance, factor: factor)
    }

    func measureAll(
        polylines: [[Vec2]],
        field: RidgeField,
        luminance: GrayImage,
        scale: SurfaceScale
    ) -> [CrackMeasurement] {
        let estimator = WidthEstimator(options: options.width)
        var results: [CrackMeasurement] = []

        for polyline in polylines.prefix(options.maxCracks) {
            let hint = widthHint(for: polyline, field: field)
            if let m = estimator.measure(
                image: luminance,
                centerline: polyline,
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
