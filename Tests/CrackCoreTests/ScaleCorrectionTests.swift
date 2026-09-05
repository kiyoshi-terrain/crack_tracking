import XCTest
@testable import CrackCore

/// 既知の長さで縦尺を合わせる。
final class ScaleCorrectionTests: XCTestCase {

    /// 平面を法線方向に k 倍動かすと、面上の距離はすべて k 倍になる（斜めの面でも）。
    func testScalingThePlaneScalesEverySurfaceDistance() throws {
        let intrinsics = CameraIntrinsics(fx: 3000, fy: 3000, cx: 2016, cy: 1512, imageWidth: 4032, imageHeight: 3024)
        // 少し傾いた壁（法線が光軸から 20° ずれている）、距離 0.3m
        let tilted = Plane(normal: Vec3(sin(20 * Double.pi / 180), 0, -cos(20 * Double.pi / 180)), distance: -0.3)
        let before = SurfaceScale(intrinsics: intrinsics, plane: tilted)
        let after = SurfaceScale(intrinsics: intrinsics, plane: ScaleCorrection.plane(tilted, scaledBy: 1.04))

        let pairs = [
            (Vec2(2000, 1500), Vec2(2400, 1500)),
            (Vec2(500, 300), Vec2(520, 900)),
            (Vec2(3500, 2800), Vec2(3400, 2000)),
        ]
        for (a, b) in pairs {
            let d0 = try XCTUnwrap(before.surfaceDistance(from: a, to: b))
            let d1 = try XCTUnwrap(after.surfaceDistance(from: a, to: b))
            XCTAssertEqual(d1 / d0, 1.04, accuracy: 1e-9)
        }
        // mm/px も同じ倍率
        let center = Vec2(2016, 1512)
        let p0 = try XCTUnwrap(before.nominalMillimetersPerPixel(at: center))
        let p1 = try XCTUnwrap(after.nominalMillimetersPerPixel(at: center))
        XCTAssertEqual(p1 / p0, 1.04, accuracy: 1e-9)
        // 入射角は変わらない
        XCTAssertEqual(
            try XCTUnwrap(after.incidenceAngleDegrees(at: center)),
            try XCTUnwrap(before.incidenceAngleDegrees(at: center)),
            accuracy: 1e-9
        )
    }

    func testFactorFromKnownLength() {
        // LiDAR の縦尺で 97.2mm と測れた目印が実際は 100mm → 1.0288 倍
        XCTAssertEqual(try XCTUnwrap(ScaleCorrection.factor(measuredMM: 97.2, knownMM: 100)), 1.0288, accuracy: 1e-4)
        XCTAssertNil(ScaleCorrection.factor(measuredMM: 0, knownMM: 100))
        XCTAssertNil(ScaleCorrection.factor(measuredMM: 50, knownMM: -1))
        XCTAssertNil(ScaleCorrection.factor(measuredMM: .nan, knownMM: 100))
    }

    /// 既に測った候補に倍率を当てると、幅・延長・mm/px だけが変わる。
    func testScaledMeasurementKeepsPixelsAndScalesMillimeters() {
        let sample = WidthSample(
            position: Vec2(10, 10), normal: Vec2(1, 0), widthPixels: 6, widthMM: 0.6,
            contrast: 0.5, millimetersPerPixel: 0.1, confidence: 0.8
        )
        let m = CrackMeasurement(
            centerline: [Vec2(10, 0), Vec2(10, 20)], samples: [sample, sample],
            lengthMM: 2.0, maxWidthMM: 0.6, meanWidthMM: 0.6,
            millimetersPerPixel: 0.1, isResolutionSufficient: true, confidence: 0.8
        )
        let s = m.scaled(by: 1.05)
        XCTAssertEqual(s.id, m.id)
        XCTAssertEqual(s.centerline, m.centerline)
        XCTAssertEqual(s.maxWidthMM, 0.63, accuracy: 1e-9)
        XCTAssertEqual(s.meanWidthMM, 0.63, accuracy: 1e-9)
        XCTAssertEqual(s.lengthMM, 2.1, accuracy: 1e-9)
        XCTAssertEqual(s.millimetersPerPixel, 0.105, accuracy: 1e-9)
        XCTAssertEqual(s.samples[0].widthMM, 0.63, accuracy: 1e-9)
        XCTAssertEqual(s.samples[0].widthPixels, 6, accuracy: 1e-9)
        XCTAssertTrue(s.isResolutionSufficient)
        // 1 倍なら同じもの
        XCTAssertEqual(m.scaled(by: 1).maxWidthMM, m.maxWidthMM)
        // 不正な倍率は無視
        XCTAssertEqual(m.scaled(by: 0).maxWidthMM, m.maxWidthMM)
    }

    /// 記録に縦尺補正の倍率が残り、無い古い記録も読める。
    func testCrackRecordCarriesScaleCorrectionAndDecodesWithoutIt() throws {
        var record = CrackRecord(
            label: "C-001", maxWidthMM: 1.0, meanWidthMM: 0.9, lengthMM: 50,
            millimetersPerPixel: 0.1, distance: 0.3, incidenceAngleDegrees: 5,
            confidence: 0.8, isResolutionSufficient: true
        )
        XCTAssertNil(record.scaleCorrection)
        record.scaleCorrection = 1.038
        let data = try JSONEncoder().encode(record)
        let decoded = try JSONDecoder().decode(CrackRecord.self, from: data)
        XCTAssertEqual(decoded.scaleCorrection, 1.038)

        // 補正の無い JSON（旧版）も読める
        var json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        json.removeValue(forKey: "scaleCorrection")
        let old = try JSONDecoder().decode(CrackRecord.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(old.scaleCorrection)
    }
}
