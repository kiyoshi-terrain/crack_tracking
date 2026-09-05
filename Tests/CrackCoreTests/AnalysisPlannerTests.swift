import XCTest
@testable import CrackCore

/// 「検出は縮小画像・計測は原寸」の分離と、目標幅からのパラメータ決定。
final class AnalysisPlannerTests: XCTestCase {

    func testDetectionFactorFollowsTargetWidth() {
        // 4px なら等倍、20px なら 5 分の 1。細すぎても 1 未満にはならない
        XCTAssertEqual(AnalysisPlanner.detectionFactor(targetWidthPx: 4), 1)
        XCTAssertEqual(AnalysisPlanner.detectionFactor(targetWidthPx: 7.9), 1)
        XCTAssertEqual(AnalysisPlanner.detectionFactor(targetWidthPx: 8), 2)
        XCTAssertEqual(AnalysisPlanner.detectionFactor(targetWidthPx: 20), 5)
        XCTAssertEqual(AnalysisPlanner.detectionFactor(targetWidthPx: 0.5), 1)
        XCTAssertEqual(AnalysisPlanner.detectionFactor(targetWidthPx: .nan), 1)
    }

    func testTargetWidthInPixelsFromResolution() {
        // 1.0mm を 0.05mm/px で撮ると 20px
        XCTAssertEqual(AnalysisPlanner.targetWidthPx(targetWidthMM: 1.0, millimetersPerPixel: 0.05), 20, accuracy: 1e-9)
        // 0.2mm を 0.19mm/px（実機・ライブ映像）では 1px 級
        XCTAssertEqual(AnalysisPlanner.targetWidthPx(targetWidthMM: 0.2, millimetersPerPixel: 0.19), 1.05, accuracy: 0.01)
    }

    func testClampRegionKeepsCenter() {
        let region = PixelRect(x: 1000, y: 500, width: 4032, height: 1875)
        let clamped = AnalysisPlanner.clampRegion(region, maxSide: 1800)
        XCTAssertEqual(clamped.width, 1800)
        XCTAssertEqual(clamped.height, 1800)
        // 中心は動かない
        XCTAssertEqual(clamped.x + clamped.width / 2, region.x + region.width / 2)
        XCTAssertEqual(clamped.y + clamped.height / 2, region.y + region.height / 2)

        // 上限内ならそのまま
        let small = PixelRect(x: 10, y: 20, width: 300, height: 200)
        XCTAssertEqual(AnalysisPlanner.clampRegion(small, maxSide: 1800), small)
    }

    func testMaxAnalysisSideGrowsWithFactor() {
        // 縮小率 5 なら原寸で 9000px 角まで解析できる（検出画像は 1800px 角）
        XCTAssertEqual(AnalysisPlanner.maxAnalysisSide(factor: 1), 1800)
        XCTAssertEqual(AnalysisPlanner.maxAnalysisSide(factor: 5), 9000)
    }

    func testDetectorOptionsScaleWithTargetWidth() {
        let fine = AnalysisPlanner.detectorOptions(targetWidthPx: 4)
        XCTAssertEqual(fine.downsampleFactor, 1)
        XCTAssertEqual(fine.ridgeScales, [1.6, 2.8, 4.8, 8.0], accuracy: 1e-9)
        XCTAssertEqual(fine.backgroundRadiusPx, 32)
        XCTAssertEqual(fine.width.maxProfileRadiusPx, 32, accuracy: 1e-9)

        let wide = AnalysisPlanner.detectorOptions(targetWidthPx: 20)
        XCTAssertEqual(wide.downsampleFactor, 5)
        XCTAssertEqual(wide.ridgeScales, [8, 14, 24, 40], accuracy: 1e-9)
        XCTAssertEqual(wide.backgroundRadiusPx, 160)
        // 断面の探索半径は幅の 8 倍まで広げる（28 のままだと 40px の亀裂の背景が取れない）
        XCTAssertEqual(wide.width.maxProfileRadiusPx, 160, accuracy: 1e-9)

        // 細すぎる目標でもカーネルの床は守る
        let hairline = AnalysisPlanner.detectorOptions(targetWidthPx: 1)
        XCTAssertEqual(hairline.ridgeScales, [0.8, 1.0, 1.4, 2.0], accuracy: 1e-9)
    }

    /// 近接（0.05mm/px）で 24px＝1.2mm の開口。目標幅 1.0mm（20px）なら縮小率 5 で検出し、
    /// 原寸の断面で幅を測る。両脇 2 本に割れず、幅も芯線も原寸で正しいこと。
    func testWideCrackIsDetectedOnceAndMeasuredAtFullResolution() throws {
        let size = 400
        let truthPx = 24.0
        let image = SyntheticImage.straightCrack(
            width: size, height: size, crackWidthPx: truthPx, blurSigma: 1.0
        )
        // f=1000px・距離 0.05m → 0.05 mm/px → 真幅 1.2mm
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: size, imageHeight: size, focalPixels: 1000, distance: 0.05
        )
        var options = AnalysisPlanner.detectorOptions(targetWidthPx: 20)
        options.width.psfSigmaPx = 1.0
        XCTAssertEqual(options.downsampleFactor, 5)

        let result = CrackDetector(options: options).detect(in: image, scale: scale)
        XCTAssertEqual(result.detectionFactor, 5)
        XCTAssertEqual(result.measurements.count, 1, "幅広の亀裂が 1 本として出なかった: \(result.measurements.count)本")

        let crack = try XCTUnwrap(result.measurements.first)
        XCTAssertEqual(crack.maxWidthMM, 1.2, accuracy: 0.1)
        XCTAssertEqual(crack.meanWidthMM, 1.2, accuracy: 0.1)
        XCTAssertTrue(crack.isResolutionSufficient)
        XCTAssertGreaterThan(crack.lengthMM, 15)

        // 芯線は原寸座標で返る（検出画像の座標のままだと 1/5 の位置に出る）
        let trueCenterX = Double(size - 1) / 2
        for point in crack.centerline {
            XCTAssertEqual(point.x, trueCenterX, accuracy: 3.0)
        }
        // 検出マスクは検出画像の解像度
        XCTAssertEqual(result.skeleton.width, size / 5)
    }

    /// タップ計測も縮小率に関わらず原寸座標で受け、原寸座標で返す。
    func testTapMeasurementWorksWithDownsampledDetection() throws {
        let size = 400
        let image = SyntheticImage.straightCrack(
            width: size, height: size, crackWidthPx: 24.0, blurSigma: 1.0
        )
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: size, imageHeight: size, focalPixels: 1000, distance: 0.05
        )
        var options = AnalysisPlanner.detectorOptions(targetWidthPx: 20)
        options.width.psfSigmaPx = 1.0
        let detector = CrackDetector(options: options)

        // 芯線から 10px 外れた位置をタップ。探索半径は原寸 px で渡す
        let crack = try XCTUnwrap(
            detector.measureCrack(in: image, near: Vec2(210, 200), scale: scale, searchRadiusPx: 40)
        )
        XCTAssertEqual(crack.maxWidthMM, 1.2, accuracy: 0.1)
        let trueCenterX = Double(size - 1) / 2
        for point in crack.centerline {
            XCTAssertEqual(point.x, trueCenterX, accuracy: 3.0)
        }

        // 探索半径の外なら見つからない
        XCTAssertNil(detector.measureCrack(in: image, near: Vec2(320, 200), scale: scale, searchRadiusPx: 40))
    }

    /// 等倍（縮小率 1）の挙動は以前と同じ。
    func testFactorOneIsIdentity() throws {
        let image = SyntheticImage.straightCrack(width: 200, height: 200, crackWidthPx: 5.0, blurSigma: 0.5)
        let scale = SyntheticImage.frontoParallelScale(imageWidth: 200, imageHeight: 200, focalPixels: 1000, distance: 0.1)
        let options = AnalysisPlanner.detectorOptions(targetWidthPx: 5)
        XCTAssertEqual(options.downsampleFactor, 1)
        let result = CrackDetector(options: options).detect(in: image, scale: scale)
        XCTAssertEqual(result.measurements.count, 1)
        XCTAssertEqual(try XCTUnwrap(result.measurements.first).maxWidthMM, 0.5, accuracy: 0.12)
    }
}

private func XCTAssertEqual(_ a: [Double], _ b: [Double], accuracy: Double, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(a.count, b.count, "要素数が違う: \(a) vs \(b)", file: file, line: line)
    for (x, y) in zip(a, b) {
        XCTAssertEqual(x, y, accuracy: accuracy, file: file, line: line)
    }
}
