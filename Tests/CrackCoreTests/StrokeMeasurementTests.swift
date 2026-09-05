import XCTest
@testable import CrackCore

/// なぞり計測・候補フィルタ・回転写像・動きの判定。
final class StrokeMeasurementTests: XCTestCase {

    /// 縦線を塗る（エッジはくっきり。目地や並走する線の模擬）
    private func paintVerticalLine(_ image: inout GrayImage, centerX: Int, halfWidth: Int, value: Float, rows: Range<Int>? = nil) {
        for y in rows ?? (0..<image.height) {
            for x in (centerX - halfWidth)..<(centerX + halfWidth) where x >= 0 && x < image.width {
                image[x, y] = value
            }
        }
    }

    private func scene() -> (GrayImage, SurfaceScale) {
        let size = 400
        // 6px の亀裂（x=199.5）。0.1 mm/px なので 0.6mm
        var image = SyntheticImage.straightCrack(width: size, height: size, crackWidthPx: 6.0, blurSigma: 0.6)
        // 60px 右に並走する 4px の線（目地のつもり）
        paintVerticalLine(&image, centerX: 260, halfWidth: 2, value: 0.30)
        let scale = SyntheticImage.frontoParallelScale(imageWidth: size, imageHeight: size, focalPixels: 1000, distance: 0.1)
        return (image, scale)
    }

    /// なぞった線に近い 1 本だけを、なぞった区間に限って測る。
    func testStrokePicksTheTracedCrackAndClipsToTheStrokeExtent() throws {
        let (image, scale) = scene()
        let detector = CrackDetector(options: AnalysisPlanner.detectorOptions(targetWidthPx: 6))

        // 芯線から 7.5px ずれた位置を y=60→340 でなぞる（指の精度の模擬）
        let stroke = [Vec2(207, 60), Vec2(207, 200), Vec2(207, 340)]
        let crack = try XCTUnwrap(
            detector.measureAlong(in: image, stroke: stroke, scale: scale, searchRadiusPx: 30)
        )
        XCTAssertEqual(crack.maxWidthMM, 0.6, accuracy: 0.12)
        for point in crack.centerline {
            XCTAssertEqual(point.x, 199.5, accuracy: 1.5, "並走する線を拾った")
            XCTAssertGreaterThan(point.y, 50, "なぞった区間の外へ広がった")
            XCTAssertLessThan(point.y, 350, "なぞった区間の外へ広がった")
        }
        // なぞった区間（280px = 28mm）に限られる。全長 40mm ではない
        XCTAssertEqual(crack.lengthMM, 28, accuracy: 6)

        // 並走する線をなぞればそちらが出る
        let other = try XCTUnwrap(
            detector.measureAlong(in: image, stroke: [Vec2(262, 80), Vec2(262, 320)], scale: scale, searchRadiusPx: 30)
        )
        for point in other.centerline {
            XCTAssertEqual(point.x, 259.5, accuracy: 1.5)
        }
        XCTAssertEqual(other.maxWidthMM, 0.4, accuracy: 0.12)

        // 何も無いところをなぞれば nil
        XCTAssertNil(detector.measureAlong(in: image, stroke: [Vec2(80, 60), Vec2(80, 340)], scale: scale, searchRadiusPx: 30))
    }

    /// 芯線が途中で切れていても、なぞった線上で区間が重ならない断片は 1 本にまとまる。
    func testStrokeMergesFragmentsAcrossAGap() throws {
        let size = 400
        var image = SyntheticImage.straightCrack(width: size, height: size, crackWidthPx: 6.0, blurSigma: 0.6)
        // y=190..210 を背景で塗って切る
        for y in 190...210 {
            for x in 180..<220 { image[x, y] = 0.85 }
        }
        let scale = SyntheticImage.frontoParallelScale(imageWidth: size, imageHeight: size, focalPixels: 1000, distance: 0.1)
        let detector = CrackDetector(options: AnalysisPlanner.detectorOptions(targetWidthPx: 6))

        let crack = try XCTUnwrap(
            detector.measureAlong(in: image, stroke: [Vec2(200, 40), Vec2(200, 360)], scale: scale, searchRadiusPx: 30)
        )
        // 上下両方の断片が入っている
        XCTAssertTrue(crack.centerline.contains { $0.y < 180 }, "上の断片が無い")
        XCTAssertTrue(crack.centerline.contains { $0.y > 220 }, "下の断片が無い")
        // 320px のうち切れ目 20px を除いた 30mm 前後
        XCTAssertEqual(crack.lengthMM, 30, accuracy: 8)
        XCTAssertEqual(crack.maxWidthMM, 0.6, accuracy: 0.12)
    }

    /// 回廊に平行な線が 2 本入ったら、長い方ではなく**なぞった線に近い方**を採る。
    /// クラックスケールの目盛りは数 mm 間隔で並ぶので、長さで選ぶと隣の目盛りが出る。
    func testStrokePrefersTheNearerOfTwoParallelLines() throws {
        let size = 400
        var image = GrayImage(width: size, height: size, repeating: 0.85)
        // A: x=199.5、短い（y 100..300）。B: x=214.5、長い（y 40..360）。どちらも 6px
        paintVerticalLine(&image, centerX: 200, halfWidth: 3, value: 0.30, rows: 100..<300)
        paintVerticalLine(&image, centerX: 215, halfWidth: 3, value: 0.30, rows: 40..<360)
        let scale = SyntheticImage.frontoParallelScale(imageWidth: size, imageHeight: size, focalPixels: 1000, distance: 0.1)
        let detector = CrackDetector(options: AnalysisPlanner.detectorOptions(targetWidthPx: 6))

        // A の真上をなぞる。半径 30 なので B も回廊に入る
        let crack = try XCTUnwrap(
            detector.measureAlong(in: image, stroke: [Vec2(200, 120), Vec2(200, 280)], scale: scale, searchRadiusPx: 30)
        )
        for point in crack.centerline {
            XCTAssertEqual(point.x, 199.5, accuracy: 1.5, "長い方（隣の線）を拾った")
        }
        XCTAssertEqual(crack.maxWidthMM, 0.6, accuracy: 0.12)

        // B の真上をなぞれば B
        let other = try XCTUnwrap(
            detector.measureAlong(in: image, stroke: [Vec2(215, 120), Vec2(215, 280)], scale: scale, searchRadiusPx: 30)
        )
        for point in other.centerline {
            XCTAssertEqual(point.x, 214.5, accuracy: 1.5)
        }
    }

    /// 縮小率 > 1 でもなぞり計測は原寸座標で受けて原寸座標で返す。
    func testStrokeWorksWithDownsampledDetection() throws {
        let size = 400
        let image = SyntheticImage.straightCrack(width: size, height: size, crackWidthPx: 24.0, blurSigma: 1.0)
        let scale = SyntheticImage.frontoParallelScale(imageWidth: size, imageHeight: size, focalPixels: 1000, distance: 0.05)
        var options = AnalysisPlanner.detectorOptions(targetWidthPx: 20)
        options.width.psfSigmaPx = 1.0
        let detector = CrackDetector(options: options)

        let crack = try XCTUnwrap(
            detector.measureAlong(in: image, stroke: [Vec2(210, 60), Vec2(210, 340)], scale: scale, searchRadiusPx: 60)
        )
        XCTAssertEqual(crack.maxWidthMM, 1.2, accuracy: 0.1)
        for point in crack.centerline {
            XCTAssertEqual(point.x, 199.5, accuracy: 3.0)
        }
    }

    func testStrokePathCorridorHasNoEndCaps() {
        let path = StrokePath(points: [Vec2(0, 0), Vec2(100, 0)])
        XCTAssertEqual(path.length, 100, accuracy: 1e-9)
        XCTAssertTrue(path.containsInCorridor(Vec2(50, 5), radius: 10))
        XCTAssertFalse(path.containsInCorridor(Vec2(50, 15), radius: 10))
        // 端の外は、線からの距離が半径以内でも区間の外
        XCTAssertFalse(path.containsInCorridor(Vec2(105, 0), radius: 10))
        XCTAssertEqual(path.arcLength(nearestTo: Vec2(30, 7)), 30, accuracy: 1e-9)
        XCTAssertEqual(path.arcLength(nearestTo: Vec2(130, 0)), 100, accuracy: 1e-9)
        XCTAssertEqual(path.distance(to: Vec2(50, 5)), 5, accuracy: 1e-9)
    }

    // MARK: - 候補フィルタ

    private func measurement(lengthMM: Double, widthMM: Double, confidence: Double) -> CrackMeasurement {
        CrackMeasurement(
            centerline: [Vec2(0, 0), Vec2(0, 10)],
            samples: [],
            lengthMM: lengthMM,
            maxWidthMM: widthMM,
            meanWidthMM: widthMM,
            millimetersPerPixel: 0.1,
            isResolutionSufficient: true,
            confidence: confidence
        )
    }

    func testCandidateFilterDropsSpecksAndKeepsCracks() {
        let filter = CandidateFilter.default
        // 実機で出た「1.86 mm / L 2 mm」のような点状の候補
        XCTAssertFalse(filter.passes(measurement(lengthMM: 2, widthMM: 1.86, confidence: 0.8)))
        // 長さはあるが幅に対して短い（斑点）
        XCTAssertFalse(filter.passes(measurement(lengthMM: 12, widthMM: 3.0, confidence: 0.8)))
        // 信頼度が低い
        XCTAssertFalse(filter.passes(measurement(lengthMM: 80, widthMM: 0.5, confidence: 0.2)))
        // 亀裂らしいもの
        XCTAssertTrue(filter.passes(measurement(lengthMM: 52, widthMM: 1.54, confidence: 0.7)))
        XCTAssertTrue(filter.passes(measurement(lengthMM: 20, widthMM: 0.3, confidence: 0.5)))
        XCTAssertNotNil(filter.rejectionReason(for: measurement(lengthMM: 2, widthMM: 1.86, confidence: 0.8)))
        XCTAssertNil(filter.rejectionReason(for: measurement(lengthMM: 52, widthMM: 1.54, confidence: 0.7)))
        // 何も落とさないフィルタ
        XCTAssertTrue(CandidateFilter.none.passes(measurement(lengthMM: 2, widthMM: 1.86, confidence: 0.1)))
    }

    // MARK: - 回転写像

    func testRotatedImageMappingRoundTripsForEveryQuarterTurn() {
        let w = 4032, h = 3024
        let corners = [Vec2(0, 0), Vec2(Double(w - 1), 0), Vec2(0, Double(h - 1)), Vec2(Double(w - 1), Double(h - 1)), Vec2(1000.5, 200.25)]
        for turns in 0..<4 {
            let m = RotatedImageMapping(rawWidth: w, rawHeight: h, quarterTurnsClockwise: turns)
            XCTAssertEqual(m.rotatedWidth, turns % 2 == 0 ? w : h)
            XCTAssertEqual(m.rotatedHeight, turns % 2 == 0 ? h : w)
            for p in corners {
                let back = m.toRaw(m.toRotated(p))
                XCTAssertEqual(back.x, p.x, accuracy: 1e-9, "turns=\(turns)")
                XCTAssertEqual(back.y, p.y, accuracy: 1e-9, "turns=\(turns)")
                // 回した画像の中に収まる
                let r = m.toRotated(p)
                XCTAssertGreaterThanOrEqual(r.x, 0)
                XCTAssertGreaterThanOrEqual(r.y, 0)
                XCTAssertLessThanOrEqual(r.x, Double(m.rotatedWidth - 1))
                XCTAssertLessThanOrEqual(r.y, Double(m.rotatedHeight - 1))
            }
        }
    }

    /// 縦持ち（90° 時計回り）: 元画像の左上は回した画像の右上、左下は左上に来る。
    func testPortraitRotationSendsTopLeftToTopRight() {
        let m = RotatedImageMapping(rawWidth: 4032, rawHeight: 3024, quarterTurnsClockwise: 1)
        let topLeft = m.toRotated(Vec2(0, 0))
        XCTAssertEqual(topLeft.x, 3023, accuracy: 1e-9)
        XCTAssertEqual(topLeft.y, 0, accuracy: 1e-9)
        let bottomLeft = m.toRotated(Vec2(0, 3023))
        XCTAssertEqual(bottomLeft.x, 0, accuracy: 1e-9)
        XCTAssertEqual(bottomLeft.y, 0, accuracy: 1e-9)
        // 距離は保たれる（探索半径をそのまま使える）
        let a = m.toRotated(Vec2(100, 100)), b = m.toRotated(Vec2(130, 140))
        XCTAssertEqual(a.distance(to: b), 50, accuracy: 1e-9)
    }

    // MARK: - 動き

    func testMovingCameraProducesAWarningAndStillCameraDoesNot() {
        let evaluator = CaptureQualityEvaluator()
        func conditions(speed: Double) -> CaptureConditions {
            CaptureConditions(
                distance: 0.4, incidenceAngleDegrees: 5, millimetersPerPixel: 0.05,
                focusScore: 0.01, meanLuminance: 0.5, saturatedRatio: 0, planeResidual: 0.003,
                isTrackingStable: true, angularSpeedDegPerSec: speed
            )
        }
        let moving = evaluator.evaluate(conditions(speed: 30))
        XCTAssertTrue(moving.issues.contains { $0.id == "motion" && $0.level == .warning })
        XCTAssertTrue(moving.primaryMessage.contains("止めて"))
        XCTAssertTrue(moving.canCapture, "動きは警告であってブロックではない（静止は計測側が待つ）")

        let still = evaluator.evaluate(conditions(speed: 2))
        XCTAssertFalse(still.issues.contains { $0.id == "motion" })
        XCTAssertEqual(still.level, .good)
    }
}
