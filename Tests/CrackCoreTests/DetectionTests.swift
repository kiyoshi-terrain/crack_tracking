import XCTest
@testable import CrackCore

final class DetectionTests: XCTestCase {

    func testRidgeResponsePeaksOnTheCrackCenter() {
        let image = SyntheticImage.straightCrack(crackWidthPx: 3.0, blurSigma: 0.6)
        let enhanced = ImageFilters.darkTopHat(image, radius: 20)
        let field = RidgeDetector.compute(enhanced, polarity: .brightLine)

        let cx = image.width / 2
        let cy = image.height / 2
        let onCrack = field.strengthValue(x: cx, y: cy)
        let offCrack = field.strengthValue(x: cx + 20, y: cy)

        XCTAssertGreaterThan(onCrack, 0)
        XCTAssertGreaterThan(onCrack, offCrack * 10)

        // 垂直な線なので、線を横切る方向はほぼ水平
        let normal = field.normal(x: cx, y: cy)
        XCTAssertEqual(abs(normal.x), 1.0, accuracy: 0.1)
    }

    /// 極性を間違えると、リッジ検出は芯線ではなく線の**両脇**に応答する。
    ///
    /// `darkTopHat` の出力は「背景よりどれだけ暗いか」なので、
    /// ひび割れは明るい線になる。ここに `.darkLine` を渡すと、
    /// 芯（曲率が負）の応答が捨てられ、曲率が正になる両脇だけが残る。
    /// 見た目には「それらしい線」が検出されるので気づきにくく、
    /// 幅も位置も数 px ずれる。
    func testRidgePolarityMustMatchTheInput() {
        let image = SyntheticImage.straightCrack(crackWidthPx: 3.0, blurSigma: 0.6)
        let enhanced = ImageFilters.darkTopHat(image, radius: 20)
        let cx = image.width / 2
        let cy = image.height / 2

        let correct = RidgeDetector.compute(enhanced, polarity: .brightLine)
        XCTAssertGreaterThan(correct.strengthValue(x: cx, y: cy), 0)

        let wrong = RidgeDetector.compute(enhanced, polarity: .darkLine)
        XCTAssertEqual(wrong.strengthValue(x: cx, y: cy), 0, "極性を誤ると芯線上の応答が消える")
        // 両脇には応答が出てしまう
        XCTAssertGreaterThan(wrong.strengthValue(x: cx - 4, y: cy), 0)
    }

    /// 検出された芯線が本当のひび割れ中心に乗っていること。
    /// 芯線がずれると法線方向がずれ、幅が cos で過大に出る。
    func testDetectedCenterlineLandsOnTheCrackCenter() throws {
        let size = 200
        let image = SyntheticImage.straightCrack(
            width: size, height: size, crackWidthPx: 5.0, blurSigma: 0.5
        )
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: size, imageHeight: size, focalPixels: 1000, distance: 0.1
        )
        var options = CrackDetector.Options.default
        options.backgroundRadiusPx = 20
        let result = CrackDetector(options: options).detect(in: image, scale: scale)

        // 1本のひび割れが1本として検出されること（両脇に割れて2本にならない）
        XCTAssertEqual(result.measurements.count, 1)

        let trueCenterX = Double(size - 1) / 2
        let crack = try XCTUnwrap(result.measurements.first)
        for point in crack.centerline {
            XCTAssertEqual(point.x, trueCenterX, accuracy: 1.0)
        }
    }

    func testNonMaximumSuppressionYieldsThinRidge() {
        let image = SyntheticImage.straightCrack(crackWidthPx: 4.0, blurSigma: 0.6)
        let enhanced = ImageFilters.darkTopHat(image, radius: 20)
        let field = RidgeDetector.compute(enhanced, polarity: .brightLine)
        let mask = RidgeThresholder.mask(from: field)

        // 中央行で立っている画素は数個以内（太いまま残っていない）
        let row = image.height / 2
        var count = 0
        for x in 0..<mask.width where mask[x, row] { count += 1 }
        XCTAssertGreaterThan(count, 0)
        XCTAssertLessThanOrEqual(count, 3)
    }

    func testSkeletonizerProducesSinglePixelLine() {
        var mask = BinaryMask(width: 40, height: 40)
        for y in 5..<35 {
            for x in 18..<23 { mask[x, y] = true }
        }
        let thinned = Skeletonizer.thin(mask)
        for y in 10..<30 {
            var count = 0
            for x in 0..<40 where thinned[x, y] { count += 1 }
            XCTAssertEqual(count, 1, "y=\(y) で1px にならなかった")
        }
    }

    func testPolylineTracingFindsTheLine() {
        var mask = BinaryMask(width: 60, height: 60)
        for y in 10..<50 { mask[30, y] = true }

        let lines = PolylineTracer.trace(mask)
        XCTAssertEqual(lines.count, 1)
        let length = PolylineTracer.polylineLength(lines[0])
        XCTAssertEqual(length, 39, accuracy: 2)
    }

    func testShortSpursArePruned() {
        var mask = BinaryMask(width: 60, height: 60)
        for y in 10..<50 { mask[30, y] = true }
        // 長さ4px のヒゲ
        for x in 31..<35 { mask[x, 30] = true }

        let lines = PolylineTracer.trace(mask, options: .init(minBranchLengthPx: 10))
        // 幹が分岐点で2本に割れ、ヒゲは落ちる
        XCTAssertEqual(lines.count, 2)
        for line in lines {
            XCTAssertGreaterThanOrEqual(PolylineTracer.polylineLength(line), 10)
        }
    }

    func testResampleGivesEvenSpacing() {
        let points = [Vec2(0, 0), Vec2(10, 0), Vec2(10, 10)]
        let resampled = PolylineTracer.resample(points, spacing: 2.0)
        for i in 1..<(resampled.count - 1) {
            XCTAssertEqual(resampled[i].distance(to: resampled[i - 1]), 2.0, accuracy: 1e-6)
        }
    }

    func testSimplifyKeepsCorners() {
        var points: [Vec2] = []
        for i in 0...20 { points.append(Vec2(Double(i), 0)) }
        for i in 1...20 { points.append(Vec2(20, Double(i))) }
        let simplified = PolylineTracer.simplify(points, tolerance: 0.5)
        XCTAssertEqual(simplified.count, 3)
        XCTAssertEqual(simplified[1].x, 20, accuracy: 1e-9)
    }

    /// 検出から計測までを一気通貫で動かす。
    func testFullPipelineDetectsAndMeasuresCrack() throws {
        let truthPx = 5.0
        let image = SyntheticImage.straightCrack(
            width: 200, height: 200, crackWidthPx: truthPx, blurSigma: 0.5
        )
        // GSD 0.1 mm/px → 真幅 0.5mm
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: 200, imageHeight: 200, focalPixels: 1000, distance: 0.1
        )

        var options = CrackDetector.Options.default
        options.width.psfSigmaPx = 0.5
        options.backgroundRadiusPx = 20
        let detector = CrackDetector(options: options)

        let result = detector.detect(in: image, scale: scale)
        let crack = try XCTUnwrap(result.measurements.first)

        XCTAssertEqual(crack.maxWidthMM, 0.5, accuracy: 0.12)
        XCTAssertTrue(crack.isResolutionSufficient)
        XCTAssertGreaterThan(crack.lengthMM, 10)
    }

    /// タップした位置のひび割れだけを測るモード。
    func testSeededMeasurementPicksTappedCrack() throws {
        let image = SyntheticImage.straightCrack(
            width: 200, height: 200, crackWidthPx: 4.0, blurSigma: 0.5
        )
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: 200, imageHeight: 200, focalPixels: 1000, distance: 0.1
        )
        var options = CrackDetector.Options.default
        options.backgroundRadiusPx = 20
        let detector = CrackDetector(options: options)

        let crack = detector.measureCrack(in: image, near: Vec2(100, 100), scale: scale)
        XCTAssertNotNil(crack)
        XCTAssertEqual(crack!.maxWidthMM, 0.4, accuracy: 0.12)
    }

    func testCleanWallProducesNoDetections() {
        var image = GrayImage(width: 128, height: 128, repeating: 0.7)
        // 微小なノイズだけ
        var seed: UInt64 = 42
        for i in 0..<image.pixels.count {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            let noise = Float(Double(seed >> 40) / Double(1 << 24)) - 0.5
            image.pixels[i] += noise * 0.01
        }
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: 128, imageHeight: 128, focalPixels: 1000, distance: 0.5
        )
        let result = CrackDetector().detect(in: image, scale: scale)
        XCTAssertTrue(result.measurements.isEmpty, "平滑な壁で誤検出が出た: \(result.measurements.count)本")
    }
}
