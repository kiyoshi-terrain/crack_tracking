import XCTest
@testable import CrackCore

final class CaptureAndExportTests: XCTestCase {

    private func goodConditions() -> CaptureConditions {
        CaptureConditions(
            distance: 0.5,
            incidenceAngleDegrees: 5,
            millimetersPerPixel: 0.05,
            focusScore: 0.01,
            meanLuminance: 0.5,
            saturatedRatio: 0.0,
            planeResidual: 0.003,
            isTrackingStable: true
        )
    }

    func testGoodConditionsPass() {
        let verdict = CaptureQualityEvaluator().evaluate(goodConditions())
        XCTAssertEqual(verdict.level, .good)
        XCTAssertTrue(verdict.canCapture)
        XCTAssertTrue(verdict.meetsTargetResolution)
    }

    func testInsufficientResolutionWarns() {
        var c = goodConditions()
        c.millimetersPerPixel = 0.3   // 0.2mm を 3px で撮るには 0.067mm/px 必要
        let verdict = CaptureQualityEvaluator().evaluate(c)
        XCTAssertFalse(verdict.meetsTargetResolution)
        XCTAssertEqual(verdict.level, .warning)
        XCTAssertTrue(verdict.canCapture)
        XCTAssertTrue(verdict.issues.contains { $0.id == "resolution" })
    }

    func testSteepAngleBlocks() {
        var c = goodConditions()
        c.incidenceAngleDegrees = 55
        let verdict = CaptureQualityEvaluator().evaluate(c)
        XCTAssertEqual(verdict.level, .blocking)
        XCTAssertFalse(verdict.canCapture)
    }

    func testBlurBlocks() {
        var c = goodConditions()
        c.focusScore = 0.0001
        let verdict = CaptureQualityEvaluator().evaluate(c)
        XCTAssertFalse(verdict.canCapture)
        XCTAssertTrue(verdict.issues.contains { $0.id == "focus" })
    }

    func testUnstableTrackingBlocks() {
        var c = goodConditions()
        c.isTrackingStable = false
        XCTAssertFalse(CaptureQualityEvaluator().evaluate(c).canCapture)
    }

    func testFocusScoreSeparatesSharpFromBlurred() {
        let sharp = SyntheticImage.straightCrack(crackWidthPx: 3)
        let blurred = ImageFilters.gaussianBlur(sharp, sigma: 3.0)
        let sharpScore = ImageFilters.varianceOfLaplacian(sharp)
        let blurredScore = ImageFilters.varianceOfLaplacian(blurred)
        XCTAssertGreaterThan(sharpScore, blurredScore * 5)
    }

    // MARK: - 撮影計画

    func testCoveragePlanProducesOverlappingStations() {
        let k = CameraIntrinsics(fx: 6000, fy: 6000, cx: 4032, cy: 3024, imageWidth: 8064, imageHeight: 6048)
        let plan = CoveragePlanner.plan(
            targetCrackWidthMM: 0.2,
            areaWidth: 3.0,
            areaHeight: 2.0,
            intrinsics: k
        )
        // 0.4m まで寄る必要があり、そこでの画角は 0.5m 強
        XCTAssertEqual(plan.distance, 0.4, accuracy: 0.02)
        XCTAssertEqual(plan.gsdMM, 0.0667, accuracy: 0.002)
        // 80% オーバーラップなので前進ステップはフットプリントの 20%
        XCTAssertEqual(plan.stepAlong, plan.footprintWidth * 0.2, accuracy: 1e-9)
        XCTAssertGreaterThan(plan.totalShots, 10)
    }

    func testCoverageTrackerCountsCoverage() {
        var tracker = CoverageTracker(areaWidth: 1.0, areaHeight: 1.0, cellSize: 0.1)
        XCTAssertEqual(tracker.coverageRatio, 0)

        tracker.record(footprintOrigin: Vec2(0, 0), width: 0.5, height: 1.0)
        XCTAssertEqual(tracker.coverageRatio, 0.5, accuracy: 0.15)
        XCTAssertFalse(tracker.uncoveredCenters().isEmpty)

        tracker.record(footprintOrigin: Vec2(0.4, 0), width: 0.6, height: 1.0)
        XCTAssertEqual(tracker.coverageRatio, 1.0, accuracy: 1e-9)
        XCTAssertTrue(tracker.uncoveredCenters().isEmpty)
    }

    // MARK: - 帳票

    func testGradeThresholds() {
        XCTAssertEqual(CrackGrade.grade(forWidthMM: 0.1), .hairline)
        XCTAssertEqual(CrackGrade.grade(forWidthMM: 0.25), .minor)
        XCTAssertEqual(CrackGrade.grade(forWidthMM: 0.35), .moderate)
        XCTAssertEqual(CrackGrade.grade(forWidthMM: 0.8), .severe)
    }

    func testCSVExportContainsRowsAndBOM() throws {
        let crack = CrackRecord(
            label: "C-001",
            maxWidthMM: 0.42,
            meanWidthMM: 0.31,
            lengthMM: 1250,
            millimetersPerPixel: 0.08,
            distance: 0.5,
            incidenceAngleDegrees: 8,
            confidence: 0.82,
            isResolutionSufficient: true,
            note: "打継目, カンマ,入り"
        )
        let session = CaptureSession(memberName: "橋脚 P3 west", cracks: [crack])
        let project = InspectionProject(
            name: "R7 定期点検",
            structureName: "○○高架橋",
            sessions: [session]
        )

        let data = CSVExporter.makeCSV(project: project)
        XCTAssertEqual(Array(data.prefix(3)), [0xEF, 0xBB, 0xBF])

        let text = try XCTUnwrap(String(data: data.dropFirst(3), encoding: .utf8))
        XCTAssertTrue(text.contains("C-001"))
        XCTAssertTrue(text.contains("0.42"))
        XCTAssertTrue(text.contains("要注意"))
        // カンマを含むフィールドが引用されている
        XCTAssertTrue(text.contains("\"打継目, カンマ,入り\""))
        XCTAssertEqual(text.components(separatedBy: "\r\n").count, 2)
    }

    func testManualOverrideWinsInReport() {
        var crack = CrackRecord(
            label: "C-002",
            maxWidthMM: 0.15,
            meanWidthMM: 0.12,
            lengthMM: 400,
            millimetersPerPixel: 0.1,
            distance: 1.0,
            incidenceAngleDegrees: 10,
            confidence: 0.4,
            isResolutionSufficient: false
        )
        XCTAssertEqual(crack.grade(), .hairline)
        crack.manualWidthMM = 0.6
        XCTAssertEqual(crack.reportedWidthMM, 0.6)
        XCTAssertEqual(crack.grade(), .severe)
    }

    func testCustomGradeThresholdsAreApplied() {
        let strict = CrackGrade.Thresholds(minor: 0.05, moderate: 0.1, severe: 0.15)
        XCTAssertEqual(CrackGrade.grade(forWidthMM: 0.12, thresholds: strict), .moderate)
        XCTAssertEqual(CrackGrade.grade(forWidthMM: 0.12), .hairline)
    }

    func testProjectRoundTripsThroughJSON() throws {
        let project = InspectionProject(
            name: "テスト案件",
            structureName: "橋梁A",
            sessions: [CaptureSession(memberName: "床版", cracks: [
                CrackRecord(
                    label: "C-001",
                    maxWidthMM: 0.3,
                    meanWidthMM: 0.2,
                    lengthMM: 100,
                    millimetersPerPixel: 0.05,
                    distance: 0.4,
                    incidenceAngleDegrees: 3,
                    confidence: 0.9,
                    isResolutionSufficient: true,
                    worldPosition: Vec3(1, 2, 3),
                    centerlinePixels: [Vec2(1, 2), Vec2(3, 4)]
                ),
            ])]
        )
        let encoded = try JSONEncoder().encode(project)
        let decoded = try JSONDecoder().decode(InspectionProject.self, from: encoded)
        XCTAssertEqual(decoded, project)
        XCTAssertEqual(decoded.allCracks.first?.worldPosition, Vec3(1, 2, 3))
    }
}
