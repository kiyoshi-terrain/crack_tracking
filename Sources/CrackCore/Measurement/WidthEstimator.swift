import Foundation

/// 1測点における幅計測結果。
public struct WidthSample: Codable, Sendable {
    /// 芯線上の画素座標
    public let position: Vec2
    /// 幅を測った方向（線に直交する単位ベクトル）
    public let normal: Vec2
    /// 画素単位の幅（サブピクセル）。幅校正（PSF・オフセット）を当てた後の値
    public let widthPixels: Double
    /// 補正前の半値幅（px）。**校正のやり直しに要る**ので必ず残す。
    /// これがあれば、後から σ やオフセットを変えても撮り直さずに測り直せる
    public let rawWidthPixels: Double
    /// 実寸幅（mm）
    public let widthMM: Double
    /// 断面のコントラスト（背景輝度に対する落ち込みの割合, 0...1）
    public let contrast: Double
    /// この測点の 1px あたり実寸（mm/px）
    public let millimetersPerPixel: Double
    /// 信頼度 0...1
    public let confidence: Double

    public init(
        position: Vec2,
        normal: Vec2,
        widthPixels: Double,
        rawWidthPixels: Double? = nil,
        widthMM: Double,
        contrast: Double,
        millimetersPerPixel: Double,
        confidence: Double
    ) {
        self.position = position
        self.normal = normal
        self.widthPixels = widthPixels
        self.rawWidthPixels = rawWidthPixels ?? widthPixels
        self.widthMM = widthMM
        self.contrast = contrast
        self.millimetersPerPixel = millimetersPerPixel
        self.confidence = confidence
    }
}

/// 1本のひび割れの計測結果。
public struct CrackMeasurement: Codable, Sendable, Identifiable {
    public var id: UUID
    /// 芯線（画素座標）
    public let centerline: [Vec2]
    public let samples: [WidthSample]
    /// 延長（mm）— 壁面上での実距離
    public let lengthMM: Double
    /// 最大幅（mm）。外れ値を避けるため上位パーセンタイルを採用。
    public let maxWidthMM: Double
    /// 平均幅（mm）
    public let meanWidthMM: Double
    /// 代表 mm/px
    public let millimetersPerPixel: Double
    /// 幅計測に足る分解能があったか
    public let isResolutionSufficient: Bool
    /// 総合信頼度 0...1
    public let confidence: Double

    public init(
        id: UUID = UUID(),
        centerline: [Vec2],
        samples: [WidthSample],
        lengthMM: Double,
        maxWidthMM: Double,
        meanWidthMM: Double,
        millimetersPerPixel: Double,
        isResolutionSufficient: Bool,
        confidence: Double
    ) {
        self.id = id
        self.centerline = centerline
        self.samples = samples
        self.lengthMM = lengthMM
        self.maxWidthMM = maxWidthMM
        self.meanWidthMM = meanWidthMM
        self.millimetersPerPixel = millimetersPerPixel
        self.isResolutionSufficient = isResolutionSufficient
        self.confidence = confidence
    }
}

/// 芯線に直交する輝度断面からひび割れ幅をサブピクセルで推定する。
///
/// ## 手法
/// 各測点で法線方向の輝度プロファイル p(t) を 0.25px 刻みでバイリニア補間して取得し、
/// 両端 25% の平均を背景輝度 b、中央の最小値を m として
/// **ハーフマックス（半値幅）** t_right - t_left を幅とします。
/// b と m の中間輝度を横切る位置を線形補間で求めるため、
/// 画素より細かい分解能が得られます。
///
/// ## 既知のバイアス
/// レンズの PSF により、真幅がボケの広がりより小さいと半値幅は**過大評価**になります。
/// 実測では真幅が 2px を下回るあたりから顕著です。本実装では
/// `PointSpreadCorrection` で √(w² - σ_psf²) 型の逆補正を掛け、
/// 補正しきれない領域（幅 < 最小可測幅）は `isResolutionSufficient = false` として
/// 参考値扱いにします。詳細は docs/accuracy.md を参照してください。
public struct WidthEstimator: Sendable {

    public struct Options: Sendable {
        /// 測点の間隔（px）
        public var sampleSpacingPx: Double
        /// プロファイルのサンプリング刻み（px）
        public var profileStepPx: Double
        /// プロファイルの片側長さ（px）。線幅の推定値に応じて自動拡張される。
        public var minProfileRadiusPx: Double
        public var maxProfileRadiusPx: Double
        /// これ未満のコントラストの測点は破棄する
        public var minContrast: Double
        /// レンズ+デモザイクによる実効 PSF の σ（px）。0 で補正なし。
        public var psfSigmaPx: Double
        /// 半値幅に一定で乗る太り（px）。トーンカーブの非線形や印刷のにじみのように、
        /// 幅に**比例せず一定量**乗るぶん。既知幅の線で `WidthCalibration` が解く
        public var widthOffsetPx: Double
        /// 幅の代表値に使う上位パーセンタイル（1.0 だと単発ノイズを拾う）
        public var maxWidthPercentile: Double

        public init(
            sampleSpacingPx: Double = 2.0,
            profileStepPx: Double = 0.25,
            minProfileRadiusPx: Double = 6.0,
            maxProfileRadiusPx: Double = 28.0,
            minContrast: Double = 0.04,
            psfSigmaPx: Double = 0.8,
            widthOffsetPx: Double = 0,
            maxWidthPercentile: Double = 0.95
        ) {
            self.sampleSpacingPx = sampleSpacingPx
            self.profileStepPx = profileStepPx
            self.minProfileRadiusPx = minProfileRadiusPx
            self.maxProfileRadiusPx = maxProfileRadiusPx
            self.minContrast = minContrast
            self.psfSigmaPx = psfSigmaPx
            self.widthOffsetPx = widthOffsetPx
            self.maxWidthPercentile = maxWidthPercentile
        }

        public static let `default` = Options()
    }

    public var options: Options

    public init(options: Options = .default) {
        self.options = options
    }

    /// 芯線に沿って幅を計測する。
    ///
    /// - Parameters:
    ///   - image: 元のグレースケール画像（背景除去前。輝度の絶対値が必要）
    ///   - centerline: 芯線の画素座標列
    ///   - scale: 画素→実寸の換算器
    ///   - expectedWidthHint: リッジ検出の σ から得られる幅の当たり（px）
    public func measure(
        image: GrayImage,
        centerline: [Vec2],
        scale: SurfaceScale,
        expectedWidthHint: Double? = nil
    ) -> CrackMeasurement? {
        guard centerline.count >= 2, !image.isEmpty else { return nil }

        let resampled = PolylineTracer.resample(centerline, spacing: options.sampleSpacingPx)
        let tangentList = PolylineTracer.tangents(resampled)

        let radius = min(
            options.maxProfileRadiusPx,
            max(options.minProfileRadiusPx, (expectedWidthHint ?? 2.0) * 4.0)
        )

        var samples: [WidthSample] = []
        for (point, tangent) in zip(resampled, tangentList) {
            let normal = tangent.perpendicular
            guard let profile = extractProfile(image: image, at: point, normal: normal, radius: radius),
                  let raw = halfMaximumWidth(profile: profile) else { continue }
            guard raw.contrast >= options.minContrast else { continue }

            let correctedPx = PointSpreadCorrection.correct(
                measuredWidthPx: raw.widthPixels,
                psfSigmaPx: options.psfSigmaPx,
                offsetPx: options.widthOffsetPx
            )
            guard let mmPerPx = scale.millimetersPerPixel(at: point, direction: normal), mmPerPx > 0 else { continue }

            let confidence = sampleConfidence(
                contrast: raw.contrast,
                widthPixels: correctedPx,
                symmetry: raw.symmetry
            )

            samples.append(
                WidthSample(
                    position: point,
                    normal: normal,
                    widthPixels: correctedPx,
                    rawWidthPixels: raw.widthPixels,
                    widthMM: correctedPx * mmPerPx,
                    contrast: raw.contrast,
                    millimetersPerPixel: mmPerPx,
                    confidence: confidence
                )
            )
        }

        guard samples.count >= 2 else { return nil }

        // 延長は壁面上の実距離で積算する（斜め撮影でも正しくなる）
        var lengthMM = 0.0
        for i in 1..<resampled.count {
            if let d = scale.surfaceDistance(from: resampled[i - 1], to: resampled[i]) {
                lengthMM += d * 1000
            }
        }

        return CrackMeasurement.aggregating(
            centerline: resampled,
            samples: samples,
            lengthMM: lengthMM,
            maxWidthPercentile: options.maxWidthPercentile
        )
    }

    // MARK: - 断面処理

    public struct Profile: Sendable {
        /// -radius ... +radius の等間隔サンプル
        public let values: [Double]
        public let step: Double
        public let radius: Double

        public func offset(atIndex i: Int) -> Double {
            -radius + Double(i) * step
        }
    }

    /// 芯線に直交する輝度断面を抽出する。
    public func extractProfile(image: GrayImage, at point: Vec2, normal: Vec2, radius: Double) -> Profile? {
        let n = normal.normalized
        guard n.lengthSquared > 0 else { return nil }
        let count = Int((radius * 2 / options.profileStepPx).rounded()) + 1
        guard count >= 5 else { return nil }

        var values = [Double](repeating: 0, count: count)
        for i in 0..<count {
            let t = -radius + Double(i) * options.profileStepPx
            let p = point + n * t
            guard image.contains(p) else { return nil }
            values[i] = Double(image.sample(at: p))
        }
        return Profile(values: values, step: options.profileStepPx, radius: radius)
    }

    public struct RawWidth: Sendable {
        public let widthPixels: Double
        public let contrast: Double
        /// 中心からの左右対称性 0...1（1が完全対称）。斜めエッジの誤検出を弾く。
        public let symmetry: Double
        public let backgroundLevel: Double
        public let minimumLevel: Double
    }

    /// 半値幅（Full Width at Half Minimum）をサブピクセルで求める。
    public func halfMaximumWidth(profile: Profile) -> RawWidth? {
        let v = profile.values
        let count = v.count
        guard count >= 5 else { return nil }

        // 背景輝度: 両端 25% の中央値寄りの平均（ハイライトの影響を避ける）
        let tailCount = max(2, count / 4)
        let leftTail = Array(v[0..<tailCount])
        let rightTail = Array(v[(count - tailCount)...])
        let background = (median(leftTail) + median(rightTail)) / 2
        guard background > 1e-6 else { return nil }

        // 中央付近の最小値
        let centerStart = count / 4
        let centerEnd = count - count / 4
        guard centerEnd > centerStart else { return nil }
        var minValue = Double.infinity
        var minIndex = centerStart
        for i in centerStart..<centerEnd where v[i] < minValue {
            minValue = v[i]
            minIndex = i
        }
        guard minValue < background else { return nil }

        let depth = background - minValue
        let threshold = background - depth * 0.5

        // 左側の交差点
        var leftIndex: Int?
        var i = minIndex
        while i > 0 {
            if v[i - 1] >= threshold && v[i] < threshold {
                leftIndex = i - 1
                break
            }
            i -= 1
        }
        // 右側の交差点
        var rightIndex: Int?
        i = minIndex
        while i < count - 1 {
            if v[i + 1] >= threshold && v[i] < threshold {
                rightIndex = i
                break
            }
            i += 1
        }

        guard let li = leftIndex, let ri = rightIndex else { return nil }

        let leftT = interpolateCrossing(
            a: (profile.offset(atIndex: li), v[li]),
            b: (profile.offset(atIndex: li + 1), v[li + 1]),
            target: threshold
        )
        let rightT = interpolateCrossing(
            a: (profile.offset(atIndex: ri), v[ri]),
            b: (profile.offset(atIndex: ri + 1), v[ri + 1]),
            target: threshold
        )

        let width = rightT - leftT
        guard width > 0 else { return nil }

        let center = (leftT + rightT) / 2
        // 中心が測点から離れていたら芯線がズレている（対称性が低い）
        let symmetry = max(0, 1 - abs(center) / max(width, 1e-6))

        return RawWidth(
            widthPixels: width,
            contrast: depth / background,
            symmetry: symmetry,
            backgroundLevel: background,
            minimumLevel: minValue
        )
    }

    func interpolateCrossing(a: (Double, Double), b: (Double, Double), target: Double) -> Double {
        let (x0, y0) = a
        let (x1, y1) = b
        let dy = y1 - y0
        guard abs(dy) > 1e-12 else { return (x0 + x1) / 2 }
        let t = (target - y0) / dy
        return x0 + (x1 - x0) * min(1, max(0, t))
    }

    func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        return sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }

    func sampleConfidence(contrast: Double, widthPixels: Double, symmetry: Double) -> Double {
        // コントラストが高く、線が十分太く写っていて、断面が対称なほど信頼できる
        let contrastScore = min(1, contrast / 0.25)
        let resolutionScore = min(1, widthPixels / CaptureAdvisor.defaultMinimumPixelsAcrossCrack)
        let symmetryScore = min(1, max(0, symmetry))
        return contrastScore * 0.4 + resolutionScore * 0.4 + symmetryScore * 0.2
    }
}

/// レンズ・センサのボケによる幅の過大評価を補正する。
///
/// 実効 PSF をガウシアン σ_psf、真の断面を矩形と近似すると、観測される半値幅は
/// おおよそ √(w² + (2.355·σ_psf)²) 相当まで広がります。これを逆に解いて
/// 真幅を推定します（真幅が PSF より十分小さいと解が消えるため下限でクランプ）。
/// `offsetPx` は幅に比例せず一定で乗る太り（トーンカーブの非線形・印刷のにじみ）。
/// PSF は二乗で効き（細い線ほど過大評価が大きい）、オフセットは一定で効く。
/// 形が違うので、既知幅の線を 2 通り以上測れば分けて決められる（`WidthCalibration`）。
public enum PointSpreadCorrection {
    public static func correct(measuredWidthPx: Double, psfSigmaPx: Double, offsetPx: Double = 0) -> Double {
        let reduced = measuredWidthPx - offsetPx
        let fwhm = psfSigmaPx > 0 ? WidthCalibration.fwhmPerSigma * psfSigmaPx : 0
        let squared = reduced * reduced - fwhm * fwhm
        guard reduced > 0, squared > 0 else {
            // PSF に埋もれている: 補正後の下限として観測幅の 30% を返す
            return measuredWidthPx * 0.3
        }
        return squared.squareRoot()
    }
}
