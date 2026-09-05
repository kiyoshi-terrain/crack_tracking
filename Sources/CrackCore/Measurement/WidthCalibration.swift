import Foundation

/// 既知幅の線で「幅の測り方」そのものを合わせる（幅校正）。
///
/// ## なぜ要るか
///
/// 半値幅は真幅そのものではない。観測される半値幅は、真幅 w に対して
///
/// ```
/// raw = √(w² + (2.3548·σ)²) + b
/// ```
///
/// で広がる。σ はレンズ・デモザイク・ブレによる実効 PSF（**細い線ほど効く**）、
/// b は幅に比例せず一定で乗るぶん（トーンカーブの非線形、印刷のにじみ、
/// エッジの立ち上がり）。ゲージシートの校正では、この 2 つが分けられないと
/// 「σ を大きくする」と「一定量を引く」のどちらでも同じくらい合ってしまう
/// （σ 0.8＋太り 0.10mm と σ 1.35＋太り 0.05mm が同点になった）。
///
/// **形が違うので、既知幅を 2 通り以上測れば分けられる。** σ の効きは細い線に
/// 集中し、b はどの幅にも同じだけ乗る。太い線と細い線を 1 本ずつ測れば決まる。
///
/// ## 現地で解く
///
/// 係数を文献や事前の実験から借りない。端末・レンズ・ピント・距離で変わるので、
/// **クラックスケールのような既知幅の線をその場で測って解く**。σ 実測ツールの
/// 温度係数を測点自身のデータから出すのと同じ考え方。
///
/// ## 順番
///
/// 幅の px は縦尺に依らないが、**既知幅を px に直すのに縦尺が要る**
/// （w[px] = w[mm] / (mm/px)）。LiDAR の縦尺は 0.3m で 3〜10% 揺れるので、
/// 先に `ScaleCorrection`（既知の長さ）で縦尺を合わせてから幅校正を行う。
public struct WidthCalibration: Codable, Sendable, Hashable {

    /// ガウシアンの σ から半値全幅への係数
    public static let fwhmPerSigma: Double = 2.3548

    /// 校正に使った 1 本（既知幅の線を実際に測った結果）。
    public struct Point: Codable, Sendable, Hashable, Identifiable {
        public var id: UUID
        /// 実際の幅（mm）。クラックスケールの目盛りなど
        public var knownWidthMM: Double
        /// 補正前に測れた半値幅の代表値（px, 中央値）
        public var rawWidthPx: Double
        /// そのときの分解能（mm/px）。既知幅を px に直すのに使う
        public var millimetersPerPixel: Double
        public var measuredAt: Date

        public init(
            id: UUID = UUID(),
            knownWidthMM: Double,
            rawWidthPx: Double,
            millimetersPerPixel: Double,
            measuredAt: Date = Date()
        ) {
            self.id = id
            self.knownWidthMM = knownWidthMM
            self.rawWidthPx = rawWidthPx
            self.millimetersPerPixel = millimetersPerPixel
            self.measuredAt = measuredAt
        }

        /// 既知幅を px に直したもの
        public var knownWidthPx: Double {
            guard millimetersPerPixel > 0 else { return 0 }
            return knownWidthMM / millimetersPerPixel
        }

        public var isUsable: Bool {
            knownWidthMM.isFinite && knownWidthMM > 0
                && rawWidthPx.isFinite && rawWidthPx > 0
                && millimetersPerPixel.isFinite && millimetersPerPixel > 0
        }
    }

    /// 実効 PSF の σ（px）
    public var psfSigmaPx: Double
    /// 一定で乗る太り（px）
    public var offsetPx: Double
    /// 校正に使った既知幅の線
    public var points: [Point]

    public init(psfSigmaPx: Double = 0.8, offsetPx: Double = 0, points: [Point] = []) {
        self.psfSigmaPx = psfSigmaPx
        self.offsetPx = offsetPx
        self.points = points
    }

    /// 校正前の既定値（実測前の設計値）。
    public static let `default` = WidthCalibration()

    /// 実測で決めた校正か（既知幅の線を測ってあるか）。
    public var isMeasured: Bool { !points.isEmpty }

    // MARK: - 順方向・逆方向

    public var fwhmPx: Double { Self.fwhmPerSigma * max(0, psfSigmaPx) }

    /// 真幅（px）→ 観測されるはずの半値幅（px）。
    public func rawWidthPx(forTrueWidthPx width: Double) -> Double {
        (width * width + fwhmPx * fwhmPx).squareRoot() + offsetPx
    }

    /// 観測した半値幅（px）→ 真幅（px）。
    public func trueWidthPx(forRawWidthPx raw: Double) -> Double {
        PointSpreadCorrection.correct(measuredWidthPx: raw, psfSigmaPx: psfSigmaPx, offsetPx: offsetPx)
    }

    /// この校正を幅計測のオプションに反映する。
    public func applied(to options: WidthEstimator.Options) -> WidthEstimator.Options {
        var o = options
        o.psfSigmaPx = psfSigmaPx
        o.widthOffsetPx = offsetPx
        return o
    }

    /// 校正点に対する残差の rms（px）。合っていないのに合ったように見せないための指標。
    public var rmsResidualPx: Double? {
        let usable = points.filter(\.isUsable)
        guard !usable.isEmpty else { return nil }
        let sum = usable.reduce(0.0) { acc, p in
            let d = rawWidthPx(forTrueWidthPx: p.knownWidthPx) - p.rawWidthPx
            return acc + d * d
        }
        return (sum / Double(usable.count)).squareRoot()
    }

    // MARK: - 当てはめ

    /// σ の探索範囲（px）。3px を超える PSF は「ボケていて測れない」領域
    public static let sigmaRange: ClosedRange<Double> = 0...3.5
    /// オフセットの範囲（px）。負も許す（細く出る端末があり得る）
    public static let offsetRange: ClosedRange<Double> = -3...8

    /// 既知幅の線から σ とオフセットを解く。
    ///
    /// 1 点しかないときは **σ を動かさずオフセットだけ**を決める（2 つの未知数は
    /// 1 点では分けられない。σ を動かすと細い線に極端な補正が乗る）。
    /// 2 点以上なら両方を最小二乗で決める。
    ///
    /// σ とオフセットは残差の谷が斜めに伸びる（相関がある）ので、交互の 1 次元走査は
    /// 使わない。σ を走査し、各 σ でオフセットは閉じた式（残差の平均）で決める。
    public static func fit(points: [Point], fallback: WidthCalibration = .default) -> WidthCalibration {
        let usable = points.filter(\.isUsable)
        guard !usable.isEmpty else { return WidthCalibration(psfSigmaPx: fallback.psfSigmaPx, offsetPx: fallback.offsetPx, points: points) }

        if usable.count == 1 {
            let p = usable[0]
            let sigma = clamp(fallback.psfSigmaPx, to: sigmaRange)
            let fwhm = fwhmPerSigma * sigma
            let expected = (p.knownWidthPx * p.knownWidthPx + fwhm * fwhm).squareRoot()
            let offset = clamp(p.rawWidthPx - expected, to: offsetRange)
            return WidthCalibration(psfSigmaPx: sigma, offsetPx: offset, points: points)
        }

        var best = (sigma: fallback.psfSigmaPx, offset: 0.0, rss: Double.infinity)
        var sigma = sigmaRange.lowerBound
        while sigma <= sigmaRange.upperBound + 1e-9 {
            let fwhm = fwhmPerSigma * sigma
            // 残差 raw - √(w²+f²) の平均が、この σ での最良のオフセット
            var meanResidual = 0.0
            for p in usable {
                meanResidual += p.rawWidthPx - (p.knownWidthPx * p.knownWidthPx + fwhm * fwhm).squareRoot()
            }
            let offset = clamp(meanResidual / Double(usable.count), to: offsetRange)
            var rss = 0.0
            for p in usable {
                let d = (p.knownWidthPx * p.knownWidthPx + fwhm * fwhm).squareRoot() + offset - p.rawWidthPx
                rss += d * d
            }
            if rss < best.rss {
                best = (sigma, offset, rss)
            }
            sigma += 0.01
        }
        return WidthCalibration(psfSigmaPx: best.sigma, offsetPx: best.offset, points: points)
    }

    private static func clamp(_ value: Double, to range: ClosedRange<Double>) -> Double {
        guard value.isFinite else { return range.lowerBound }
        return min(range.upperBound, max(range.lowerBound, value))
    }
}

extension CrackMeasurement {

    /// 測点をまとめて 1 本の計測結果にする（幅の代表値・分解能の充足はここだけで決める）。
    static func aggregating(
        id: UUID = UUID(),
        centerline: [Vec2],
        samples: [WidthSample],
        lengthMM: Double,
        maxWidthPercentile: Double
    ) -> CrackMeasurement? {
        guard samples.count >= 2 else { return nil }
        let widths = samples.map(\.widthMM).sorted()
        let maxIndex = min(widths.count - 1, Int((Double(widths.count - 1) * maxWidthPercentile).rounded()))
        let maxWidth = widths[maxIndex]
        let meanWidth = widths.reduce(0, +) / Double(widths.count)
        let meanMMPerPx = samples.map(\.millimetersPerPixel).reduce(0, +) / Double(samples.count)
        let meanConfidence = samples.map(\.confidence).reduce(0, +) / Double(samples.count)
        let sufficient = maxWidth >= meanMMPerPx * CaptureAdvisor.defaultMinimumPixelsAcrossCrack

        return CrackMeasurement(
            id: id,
            centerline: centerline,
            samples: samples,
            lengthMM: lengthMM,
            maxWidthMM: maxWidth,
            meanWidthMM: meanWidth,
            millimetersPerPixel: meanMMPerPx,
            isResolutionSufficient: sufficient,
            confidence: sufficient ? meanConfidence : meanConfidence * 0.5
        )
    }

    /// 補正前の半値幅の代表値（px, 中央値）。幅校正に渡す値。
    ///
    /// 校正には中央値を使う（上位パーセンタイルではない）。既知幅の線は全長で同じ幅
    /// なので、数十測点の最大値を採ると必ず上振れる。
    public var medianRawWidthPx: Double? {
        median(samples.map(\.rawWidthPixels))
    }

    /// 分解能の代表値（mm/px, 中央値）。
    public var medianMillimetersPerPixel: Double? {
        median(samples.map(\.millimetersPerPixel))
    }

    private func median(_ values: [Double]) -> Double? {
        let sorted = values.filter { $0.isFinite && $0 > 0 }.sorted()
        guard !sorted.isEmpty else { return nil }
        let mid = sorted.count / 2
        return sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }

    /// 別の幅校正で測り直した写し。**撮り直さずに**幅だけを付け替える。
    ///
    /// 補正前の半値幅を測点に残してあるので、σ やオフセットを変えても現地で
    /// もう一度なぞる必要はない。mm への換算は測点ごとの mm/px を使うので、
    /// 既に当てた縦尺補正（`scaled(by:)`）はそのまま残る。
    ///
    /// 信頼度は測点の断面（コントラスト・対称性）から決まっていて、幅の補正では
    /// ほとんど動かないのでそのまま引き継ぐ。
    public func recalibrated(with calibration: WidthCalibration, maxWidthPercentile: Double = 0.95) -> CrackMeasurement {
        let rescaled = samples.map { s -> WidthSample in
            let px = calibration.trueWidthPx(forRawWidthPx: s.rawWidthPixels)
            return WidthSample(
                position: s.position,
                normal: s.normal,
                widthPixels: px,
                rawWidthPixels: s.rawWidthPixels,
                widthMM: px * s.millimetersPerPixel,
                contrast: s.contrast,
                millimetersPerPixel: s.millimetersPerPixel,
                confidence: s.confidence
            )
        }
        return CrackMeasurement.aggregating(
            id: id,
            centerline: centerline,
            samples: rescaled,
            lengthMM: lengthMM,
            maxWidthPercentile: maxWidthPercentile
        ) ?? self
    }
}
