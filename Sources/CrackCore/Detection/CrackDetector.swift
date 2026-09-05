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

    /// なぞった線に沿うひび割れ 1 本を測る（オペレータが対象を線で指定するモード）。
    ///
    /// 「枠内を全部測る」は暗くて細長いものを全部拾う（目地・斑点・影の縁）。
    /// 現場で欲しいのは「この亀裂のこの区間の幅」なので、画面でなぞった線から
    /// `searchRadiusPx` 以内にある芯線だけを対象にし、**なぞった区間に限って**測る
    /// （線の端の外へは広げない）。
    ///
    /// 芯線が途中で切れていても、なぞった線上の区間が重ならない断片は同じ亀裂の
    /// 続きとみなして 1 本にまとめる。区間が重なる断片（並走する斑点・目地・
    /// クラックスケールの隣の目盛り）は、なぞった線に近い方だけを採る。
    ///
    /// - Parameters:
    ///   - stroke: なぞった線（**原寸** px の点列）
    ///   - searchRadiusPx: 線からこの距離（**原寸** px）以内の芯線だけを対象にする
    public func measureAlong(
        in image: GrayImage,
        stroke: [Vec2],
        scale: SurfaceScale,
        searchRadiusPx: Int
    ) -> CrackMeasurement? {
        guard stroke.count >= 2 else { return nil }
        let prepared = prepare(image)
        let path = StrokePath(points: stroke.map(prepared.toDetection))
        guard path.length > 0 else { return nil }
        let radius = max(1.0, Double(searchRadiusPx) / Double(prepared.factor))

        // なぞった線の近傍（区間の中）。しきい値はこの中の応答だけで決める。
        // 画面全体のパーセンタイルだと、回廊の外にもっと強い構造（目地）があるときに
        // 亀裂が種を持てず丸ごと消える（合成検証で実際に消えた）
        let corridor = path.corridorMask(
            width: prepared.enhanced.width,
            height: prepared.enhanced.height,
            radius: radius
        )
        guard corridor.trueCount > 0 else { return nil }

        let field = RidgeDetector.compute(
            prepared.enhanced,
            scales: prepared.detectionScales(options.ridgeScales),
            polarity: .brightLine
        )
        var mask = RidgeThresholder.mask(from: field, options: options.threshold, within: corridor)
        mask = Skeletonizer.thin(mask)
        guard mask.trueCount > 0 else { return nil }

        let polylines = PolylineTracer.trace(mask, options: options.tracing)
        guard !polylines.isEmpty else { return nil }

        // 断片ごとに、なぞった線上の区間 [s0, s1] と、線からの平均距離を出す
        struct Piece {
            let polyline: [Vec2]
            let s0: Double
            let s1: Double
            let length: Double
            let distance: Double
        }
        var pieces: [Piece] = polylines.map { polyline in
            let s = polyline.map { path.arcLength(nearestTo: $0) }
            let d = polyline.map { path.distance(to: $0) }
            return Piece(
                polyline: polyline,
                s0: s.min() ?? 0,
                s1: s.max() ?? 0,
                length: PolylineTracer.polylineLength(polyline),
                distance: d.reduce(0, +) / Double(max(1, d.count))
            )
        }
        // 採否は「なぞった線に近い順」。長さで選ぶと、回廊に一緒に入った平行な線
        // （クラックスケールの隣の目盛り・並走する目地）のうち長い方が採られ、
        // 指した線ではない方が出る。ただし短すぎる断片（斑点）が近いだけで採られないよう、
        // 最長の 1/4 に満たないものは先に落とす
        let longest = pieces.map(\.length).max() ?? 0
        pieces = pieces.filter { $0.length >= longest * 0.25 }
        pieces.sort { $0.distance < $1.distance }

        // 近い順に、既に採った断片と区間が 2 割以上重ならないものだけ採る
        var accepted: [Piece] = []
        for piece in pieces {
            let span = max(piece.s1 - piece.s0, 1e-9)
            var overlap = 0.0
            for a in accepted {
                overlap += max(0, min(piece.s1, a.s1) - max(piece.s0, a.s0))
            }
            if accepted.isEmpty || overlap / span < 0.2 {
                accepted.append(piece)
            }
        }
        accepted.sort { $0.s0 < $1.s0 }

        let estimator = WidthEstimator(options: options.width)
        let parts = accepted.compactMap { piece -> CrackMeasurement? in
            let hint = widthHint(for: piece.polyline, field: field) * Double(prepared.factor)
            return estimator.measure(
                image: prepared.luminance,
                centerline: piece.polyline.map(prepared.toFullResolution),
                scale: scale,
                expectedWidthHint: hint
            )
        }
        return CrackMeasurement.merging(parts, maxWidthPercentile: options.width.maxWidthPercentile)
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

extension CrackMeasurement {
    /// 同じ亀裂の断片（なぞった線に沿って途切れた芯線）を 1 本にまとめる。
    ///
    /// 芯線は断片を順に連結し、測点は全部合わせて代表値を取り直す。
    static func merging(_ parts: [CrackMeasurement], maxWidthPercentile: Double) -> CrackMeasurement? {
        guard let first = parts.first else { return nil }
        if parts.count == 1 { return first }
        let samples = parts.flatMap(\.samples)
        guard samples.count >= 2 else { return nil }

        return CrackMeasurement.aggregating(
            centerline: parts.flatMap(\.centerline),
            samples: samples,
            lengthMM: parts.map(\.lengthMM).reduce(0, +),
            maxWidthPercentile: maxWidthPercentile
        )
    }
}
