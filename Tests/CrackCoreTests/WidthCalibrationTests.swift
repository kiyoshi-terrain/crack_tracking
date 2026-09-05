import XCTest
@testable import CrackCore

/// 既知幅の線で「幅の測り方」を合わせる（幅校正）。
final class WidthCalibrationTests: XCTestCase {

    // MARK: - 当てはめ

    /// モデル通りに作った 2 点から σ と一定の太りを取り戻す。
    ///
    /// σ は細い線にだけ効き、太りはどの幅にも同じだけ乗る。形が違うので、
    /// 太い線と細い線が 1 本ずつあれば分けられる。
    func testFitSeparatesBlurFromConstantSpread() throws {
        let truth = WidthCalibration(psfSigmaPx: 1.35, offsetPx: 1.7)
        let known: [(widthMM: Double, mmPerPx: Double)] = [(0.5, 0.1), (3.0, 0.1)]
        let points = known.map { line in
            WidthCalibration.Point(
                knownWidthMM: line.widthMM,
                rawWidthPx: truth.rawWidthPx(forTrueWidthPx: line.widthMM / line.mmPerPx),
                millimetersPerPixel: line.mmPerPx
            )
        }
        let fitted = WidthCalibration.fit(points: points)
        XCTAssertEqual(fitted.psfSigmaPx, 1.35, accuracy: 0.05)
        XCTAssertEqual(fitted.offsetPx, 1.7, accuracy: 0.05)
        XCTAssertEqual(try XCTUnwrap(fitted.rmsResidualPx), 0, accuracy: 0.02)
        XCTAssertTrue(fitted.isMeasured)
    }

    /// 1 点しかないときは σ を動かさず、太りだけを決める。
    ///
    /// 2 つの未知数は 1 点では分けられない。σ を動かすと細い線に極端な補正が乗る。
    func testSinglePointMovesOnlyTheOffset() throws {
        let fallback = WidthCalibration(psfSigmaPx: 0.8, offsetPx: 0)
        let point = WidthCalibration.Point(knownWidthMM: 1.0, rawWidthPx: 12.4, millimetersPerPixel: 0.1)
        let fitted = WidthCalibration.fit(points: [point], fallback: fallback)

        XCTAssertEqual(fitted.psfSigmaPx, 0.8, accuracy: 1e-9)
        // 10px の線が 12.4px に見えている。σ 0.8（半値 1.88px）ぶんを除いた残りが太り
        XCTAssertEqual(fitted.rawWidthPx(forTrueWidthPx: 10), 12.4, accuracy: 1e-6)
        XCTAssertGreaterThan(fitted.offsetPx, 0)
        XCTAssertEqual(try XCTUnwrap(fitted.rmsResidualPx), 0, accuracy: 1e-6)
    }

    /// 順方向と逆方向が往復すること。
    func testForwardAndInverseRoundTrip() {
        let calibration = WidthCalibration(psfSigmaPx: 1.2, offsetPx: 1.5)
        for truePx in [3.0, 6.0, 12.0, 40.0] {
            let raw = calibration.rawWidthPx(forTrueWidthPx: truePx)
            XCTAssertEqual(calibration.trueWidthPx(forRawWidthPx: raw), truePx, accuracy: 1e-6)
        }
    }

    /// 使えない点は当てはめから外し、校正が壊れないこと。
    func testUnusablePointsAreIgnored() {
        let bad = [
            WidthCalibration.Point(knownWidthMM: 0, rawWidthPx: 10, millimetersPerPixel: 0.1),
            WidthCalibration.Point(knownWidthMM: 1, rawWidthPx: 0, millimetersPerPixel: 0.1),
            WidthCalibration.Point(knownWidthMM: 1, rawWidthPx: 10, millimetersPerPixel: 0),
            WidthCalibration.Point(knownWidthMM: .nan, rawWidthPx: 10, millimetersPerPixel: 0.1),
        ]
        let fitted = WidthCalibration.fit(points: bad, fallback: .default)
        XCTAssertEqual(fitted.psfSigmaPx, WidthCalibration.default.psfSigmaPx)
        XCTAssertEqual(fitted.offsetPx, WidthCalibration.default.offsetPx)
        XCTAssertNil(fitted.rmsResidualPx)
        // 点そのものは残す（現地で消せるように）
        XCTAssertEqual(fitted.points.count, 4)
    }

    /// 補正なしの既定（σ 0・太り 0）は観測値をそのまま返す。
    func testIdentityCalibrationDoesNotChangeWidth() {
        let identity = WidthCalibration(psfSigmaPx: 0, offsetPx: 0)
        XCTAssertEqual(identity.trueWidthPx(forRawWidthPx: 7.3), 7.3, accuracy: 1e-9)
    }

    // MARK: - 画像から校正して測り直す

    /// **既知幅の線 2 本で校正すると、3 本目が実幅で出る。**
    ///
    /// 印刷した線が一定量だけ太い（あるいは端末が一定量だけ太く測る）状況を作る。
    /// 校正前は 3 本とも太く出るが、両端の 2 本の実幅を教えると、教えていない
    /// 真ん中の 1 本も実幅で出るようになる。
    func testCalibratingWithTwoKnownLinesFixesAThirdLine() throws {
        let mmPerPx = 0.1
        let spreadPx = 1.6      // 一定で乗る太り（印刷のにじみ・トーンカーブ）
        let blurSigma = 1.0     // レンズのボケ

        /// 公称幅 mm の線を、太りぶん広く描いて測る
        func measure(nominalMM: Double, calibration: WidthCalibration) throws -> CrackMeasurement {
            let drawnPx = nominalMM / mmPerPx + spreadPx
            let side = 220
            let image = SyntheticImage.straightCrack(
                width: side, height: side, crackWidthPx: drawnPx, blurSigma: blurSigma
            )
            // f=1000px, 距離 0.1m → 0.1 mm/px
            let scale = SyntheticImage.frontoParallelScale(
                imageWidth: side, imageHeight: side, focalPixels: 1000, distance: 0.1
            )
            var options = WidthEstimator.Options.default
            options = calibration.applied(to: options)
            let estimator = WidthEstimator(options: options)
            let cx = Double(side - 1) / 2
            let centerline = (40...180).map { Vec2(cx, Double($0)) }
            return try XCTUnwrap(
                estimator.measure(image: image, centerline: centerline, scale: scale, expectedWidthHint: drawnPx)
            )
        }

        // 校正前（設計値のまま）
        let thin = try measure(nominalMM: 0.5, calibration: .default)
        let middle = try measure(nominalMM: 1.2, calibration: .default)
        let thick = try measure(nominalMM: 3.0, calibration: .default)

        // 太りぶん、どれも実幅より広く出ている
        XCTAssertGreaterThan(middle.meanWidthMM - 1.2, 0.08)

        // 細い線と太い線の実幅を教える
        let taught: [(measurement: CrackMeasurement, knownMM: Double)] = [(thin, 0.5), (thick, 3.0)]
        let points = taught.map { line in
            WidthCalibration.Point(
                knownWidthMM: line.knownMM,
                rawWidthPx: line.measurement.medianRawWidthPx ?? 0,
                millimetersPerPixel: line.measurement.medianMillimetersPerPixel ?? 0
            )
        }
        let fitted = WidthCalibration.fit(points: points)
        XCTAssertEqual(fitted.offsetPx, spreadPx, accuracy: 0.5)

        // 教えていない真ん中の線が、撮り直さずに実幅で出る
        let corrected = middle.recalibrated(with: fitted)
        XCTAssertEqual(corrected.meanWidthMM, 1.2, accuracy: 0.06)
        XCTAssertEqual(corrected.centerline, middle.centerline)
        XCTAssertEqual(corrected.lengthMM, middle.lengthMM, accuracy: 1e-9)

        // 教えた 2 本も実幅になる
        XCTAssertEqual(thin.recalibrated(with: fitted).meanWidthMM, 0.5, accuracy: 0.06)
        XCTAssertEqual(thick.recalibrated(with: fitted).meanWidthMM, 3.0, accuracy: 0.1)
    }

    /// 測り直しは補正前の半値幅から計算するので、縦尺補正と重ねても壊れない。
    func testRecalibrationKeepsTheScaleCorrection() {
        let sample = WidthSample(
            position: Vec2(10, 10), normal: Vec2(1, 0), widthPixels: 10, rawWidthPixels: 12,
            widthMM: 1.0, contrast: 0.5, millimetersPerPixel: 0.1, confidence: 0.8
        )
        let measurement = CrackMeasurement(
            centerline: [Vec2(10, 0), Vec2(10, 20)], samples: [sample, sample],
            lengthMM: 2.0, maxWidthMM: 1.0, meanWidthMM: 1.0,
            millimetersPerPixel: 0.1, isResolutionSufficient: true, confidence: 0.8
        )
        // 縦尺を 1.05 倍にしてから、太りを 2px 引く校正を当てる
        let scaled = measurement.scaled(by: 1.05)
        let corrected = scaled.recalibrated(with: WidthCalibration(psfSigmaPx: 0, offsetPx: 2))

        XCTAssertEqual(corrected.samples[0].rawWidthPixels, 12, accuracy: 1e-9)
        XCTAssertEqual(corrected.samples[0].widthPixels, 10, accuracy: 1e-9)
        // 幅 10px × (0.1×1.05) mm/px
        XCTAssertEqual(corrected.meanWidthMM, 1.05, accuracy: 1e-9)
        XCTAssertEqual(corrected.millimetersPerPixel, 0.105, accuracy: 1e-9)
    }

    // MARK: - 保存

    /// 案件に校正が残り、校正の無い古い JSON も読める。
    func testProjectCarriesCalibrationAndDecodesWithoutIt() throws {
        var project = InspectionProject(name: "大谷石橋台")
        XCTAssertNil(project.widthCalibration)
        project.widthCalibration = WidthCalibration(
            psfSigmaPx: 1.35,
            offsetPx: 1.7,
            points: [WidthCalibration.Point(knownWidthMM: 0.5, rawWidthPx: 7.2, millimetersPerPixel: 0.1)]
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let data = try encoder.encode(project)
        let decoded = try decoder.decode(InspectionProject.self, from: data)
        XCTAssertEqual(decoded.widthCalibration?.psfSigmaPx, 1.35)
        XCTAssertEqual(decoded.widthCalibration?.points.count, 1)

        var json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        json.removeValue(forKey: "widthCalibration")
        let old = try decoder.decode(
            InspectionProject.self, from: JSONSerialization.data(withJSONObject: json)
        )
        XCTAssertNil(old.widthCalibration)
    }

    /// 記録に「どの校正で測ったか」が残る。
    func testRecordKeepsTheCalibrationItWasMeasuredWith() throws {
        let sample = WidthSample(
            position: Vec2(80, 80), normal: Vec2(1, 0), widthPixels: 10, rawWidthPixels: 11.7,
            widthMM: 1.0, contrast: 0.5, millimetersPerPixel: 0.1, confidence: 0.8
        )
        let measurement = CrackMeasurement(
            centerline: [Vec2(80, 60), Vec2(80, 100)], samples: [sample, sample],
            lengthMM: 4.0, maxWidthMM: 1.0, meanWidthMM: 1.0,
            millimetersPerPixel: 0.1, isResolutionSufficient: true, confidence: 0.8
        )
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: 160, imageHeight: 160, focalPixels: 1000, distance: 0.1
        )
        let record = CrackRecord(
            label: "C-001",
            measurement: measurement,
            scale: scale,
            scaleCorrection: 1.04,
            widthCalibration: WidthCalibration(psfSigmaPx: 1.35, offsetPx: 1.7)
        )
        XCTAssertEqual(try XCTUnwrap(record.widthCalibrationSigmaPx), 1.35, accuracy: 1e-9)
        XCTAssertEqual(try XCTUnwrap(record.widthCalibrationOffsetPx), 1.7, accuracy: 1e-9)

        // 校正の無い古い JSON も読める
        let data = try JSONEncoder().encode(record)
        var json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        json.removeValue(forKey: "widthCalibrationSigmaPx")
        json.removeValue(forKey: "widthCalibrationOffsetPx")
        let old = try JSONDecoder().decode(
            CrackRecord.self, from: JSONSerialization.data(withJSONObject: json)
        )
        XCTAssertNil(old.widthCalibrationSigmaPx)

        // CSV にも列が出る
        var project = InspectionProject(name: "案件")
        project.sessions = [CaptureSession(memberName: "橋台", cracks: [record])]
        let csv = String(data: CSVExporter.makeCSV(project: project, includeBOM: false), encoding: .utf8) ?? ""
        XCTAssertTrue(csv.contains("幅校正PSFσ(px)"))
        XCTAssertTrue(csv.contains("1.35"))
        XCTAssertTrue(csv.contains("1.70"))
    }
}
