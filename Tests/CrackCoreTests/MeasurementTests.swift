import XCTest
@testable import CrackCore

final class MeasurementTests: XCTestCase {

    /// ボケの無い理想画像では、半値幅は真幅とほぼ一致するはず。
    func testHalfMaximumWidthMatchesTruthWithoutBlur() throws {
        for truth in [2.0, 3.0, 4.5, 7.0] {
            let image = SyntheticImage.straightCrack(crackWidthPx: truth)
            var options = WidthEstimator.Options.default
            options.psfSigmaPx = 0   // 補正なしで素の精度を見る
            let estimator = WidthEstimator(options: options)

            let center = Vec2(Double(image.width - 1) / 2, Double(image.height - 1) / 2)
            let profile = try XCTUnwrap(estimator.extractProfile(
                image: image, at: center, normal: Vec2(1, 0), radius: 20
            ))
            let raw = try XCTUnwrap(estimator.halfMaximumWidth(profile: profile))

            XCTAssertEqual(raw.widthPixels, truth, accuracy: 0.3, "真幅 \(truth)px")
            XCTAssertGreaterThan(raw.contrast, 0.3)
            XCTAssertGreaterThan(raw.symmetry, 0.8)
        }
    }

    /// ボケがあると半値幅は過大評価になる。PSF 補正でどこまで戻るかを確認する。
    func testPointSpreadCorrectionReducesBlurBias() throws {
        let truth = 3.0
        let sigma = 0.8
        let image = SyntheticImage.straightCrack(crackWidthPx: truth, blurSigma: sigma)

        var raw = WidthEstimator.Options.default
        raw.psfSigmaPx = 0
        let uncorrected = try measureCenterWidth(image: image, options: raw)

        let correctedWidth = PointSpreadCorrection.correct(
            measuredWidthPx: uncorrected, psfSigmaPx: sigma
        )

        // ボケにより過大評価されている
        XCTAssertGreaterThan(uncorrected, truth)
        // 補正後は真値に近づく
        XCTAssertLessThan(abs(correctedWidth - truth), abs(uncorrected - truth))
    }

    /// スケールを適用して mm で返るところまで通す。
    /// GSD 0.1mm/px で 4px の亀裂 → 0.4mm。
    func testEndToEndWidthInMillimeters() throws {
        let truthPx = 4.0
        let image = SyntheticImage.straightCrack(width: 160, height: 160, crackWidthPx: truthPx)
        // f=1000px, 距離0.1m → 0.1 mm/px
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: 160, imageHeight: 160, focalPixels: 1000, distance: 0.1
        )

        var options = WidthEstimator.Options.default
        options.psfSigmaPx = 0
        let estimator = WidthEstimator(options: options)

        // 画像中央を通る垂直な芯線
        let cx = Double(image.width - 1) / 2
        let centerline = (20...140).map { Vec2(cx, Double($0)) }

        let measurement = try XCTUnwrap(
            estimator.measure(image: image, centerline: centerline, scale: scale, expectedWidthHint: truthPx)
        )

        XCTAssertEqual(measurement.millimetersPerPixel, 0.1, accuracy: 1e-3)
        XCTAssertEqual(measurement.meanWidthMM, 0.4, accuracy: 0.04)
        XCTAssertEqual(measurement.lengthMM, 12.0, accuracy: 0.5)  // 120px * 0.1mm
        XCTAssertTrue(measurement.isResolutionSufficient)
        XCTAssertGreaterThan(measurement.confidence, 0.5)
    }

    /// 分解能が足りない（亀裂が3px未満）ときはフラグが立つこと。
    func testInsufficientResolutionIsFlagged() throws {
        let image = SyntheticImage.straightCrack(width: 128, height: 128, crackWidthPx: 1.5, blurSigma: 0.7)
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: 128, imageHeight: 128, focalPixels: 1000, distance: 1.0
        )
        let estimator = WidthEstimator()
        let cx = Double(image.width - 1) / 2
        let centerline = (20...108).map { Vec2(cx, Double($0)) }

        let measurement = try XCTUnwrap(
            estimator.measure(image: image, centerline: centerline, scale: scale)
        )
        XCTAssertFalse(measurement.isResolutionSufficient)
        XCTAssertLessThan(measurement.confidence, 0.6)
    }

    /// 照明ムラがあっても、断面の背景を局所推定しているので幅は変わらないこと。
    func testWidthIsRobustToIlluminationGradient() throws {
        let truth = 4.0
        let flat = SyntheticImage.straightCrack(crackWidthPx: truth)
        let uneven = SyntheticImage.straightCrack(crackWidthPx: truth, illuminationGradient: 0.6)

        var options = WidthEstimator.Options.default
        options.psfSigmaPx = 0

        let a = try measureCenterWidth(image: flat, options: options)
        let b = try measureCenterWidth(image: uneven, options: options)
        XCTAssertEqual(a, b, accuracy: 0.2)
    }

    private func measureCenterWidth(image: GrayImage, options: WidthEstimator.Options) throws -> Double {
        let estimator = WidthEstimator(options: options)
        let center = Vec2(Double(image.width - 1) / 2, Double(image.height - 1) / 2)
        let profile = try XCTUnwrap(estimator.extractProfile(
            image: image, at: center, normal: Vec2(1, 0), radius: 20
        ))
        return try XCTUnwrap(estimator.halfMaximumWidth(profile: profile)).widthPixels
    }
}
