import XCTest
@testable import CrackCore

final class GeometryTests: XCTestCase {

    func testUnprojectProjectRoundTrip() {
        let k = CameraIntrinsics(fx: 1500, fy: 1500, cx: 640, cy: 480, imageWidth: 1280, imageHeight: 960)
        let pixel = Vec2(700, 400)
        let point = k.unproject(pixel: pixel, depth: 2.5)
        let back = k.project(point)
        XCTAssertNotNil(back)
        XCTAssertEqual(back!.x, pixel.x, accuracy: 1e-9)
        XCTAssertEqual(back!.y, pixel.y, accuracy: 1e-9)
    }

    func testIntrinsicsScaling() {
        let k = CameraIntrinsics(fx: 3000, fy: 3000, cx: 2016, cy: 1512, imageWidth: 4032, imageHeight: 3024)
        let half = k.scaled(toWidth: 2016, height: 1512)
        XCTAssertEqual(half.fx, 1500, accuracy: 1e-9)
        XCTAssertEqual(half.cx, 1008, accuracy: 1e-9)
    }

    /// 正対撮影なら mm/px = 距離[m] * 1000 / 焦点距離[px] になるはず。
    func testFrontoParallelScale() {
        let scale = SyntheticImage.frontoParallelScale(
            imageWidth: 1000, imageHeight: 1000, focalPixels: 1000, distance: 2.0
        )
        let center = Vec2(499.5, 499.5)
        let mmPerPx = scale.millimetersPerPixel(at: center, direction: Vec2(1, 0))
        XCTAssertNotNil(mmPerPx)
        XCTAssertEqual(mmPerPx!, 2.0, accuracy: 1e-6)
        XCTAssertEqual(scale.distance(at: center)!, 2.0, accuracy: 1e-6)
        XCTAssertEqual(scale.incidenceAngleDegrees(at: center)!, 0, accuracy: 1e-6)
    }

    /// 壁面を60度傾けると、傾いている方向のスケールだけが 1/cos60 = 2倍になる。
    /// この異方性を無視すると斜め撮影で幅が最大2倍ずれる。
    func testObliqueScaleIsAnisotropic() {
        let theta = 60.0 * Double.pi / 180
        let distance = 2.0
        let intrinsics = CameraIntrinsics(
            fx: 1000, fy: 1000, cx: 499.5, cy: 499.5, imageWidth: 1000, imageHeight: 1000
        )
        // x-z 平面内で傾いた壁面
        let normal = Vec3(-sin(theta), 0, -cos(theta))
        let plane = Plane(point: Vec3(0, 0, distance), normal: normal)
        let scale = SurfaceScale(intrinsics: intrinsics, plane: plane)
        let center = Vec2(499.5, 499.5)

        let horizontal = scale.millimetersPerPixel(at: center, direction: Vec2(1, 0))!
        let vertical = scale.millimetersPerPixel(at: center, direction: Vec2(0, 1))!

        XCTAssertEqual(horizontal, 2.0 / cos(theta), accuracy: 0.02)
        XCTAssertEqual(vertical, 2.0, accuracy: 0.01)
        XCTAssertEqual(scale.incidenceAngleDegrees(at: center)!, 60, accuracy: 0.5)
    }

    func testPlaneFitRecoversKnownPlane() {
        let normal = Vec3(0.2, -0.3, -0.9).normalized
        let plane = Plane(point: Vec3(0, 0, 1.5), normal: normal)

        var points: [Vec3] = []
        for i in 0..<20 {
            for j in 0..<20 {
                let x = Double(i - 10) * 0.02
                let y = Double(j - 10) * 0.02
                // 平面上の点を求める: z を解く
                // n.x*x + n.y*y + n.z*z = d
                let z = (plane.distance - normal.x * x - normal.y * y) / normal.z
                points.append(Vec3(x, y, z))
            }
        }

        let fit = PlaneFitter.fit(points: points)
        XCTAssertNotNil(fit)
        XCTAssertLessThan(fit!.rmsResidual, 1e-6)
        // 法線は符号を除いて一致
        XCTAssertEqual(abs(fit!.plane.normal.dot(normal)), 1.0, accuracy: 1e-6)
    }

    func testRobustPlaneFitRejectsOutliers() {
        let normal = Vec3(0, 0, -1)
        var points: [Vec3] = []
        for i in 0..<20 {
            for j in 0..<20 {
                points.append(Vec3(Double(i - 10) * 0.02, Double(j - 10) * 0.02, 2.0))
            }
        }
        // デプスの飛び（手前の障害物）を混入させる
        for i in 0..<30 {
            points.append(Vec3(Double(i) * 0.005, 0.1, 0.8))
        }

        let robust = PlaneFitter.fitRobust(points: points)
        XCTAssertNotNil(robust)
        XCTAssertEqual(abs(robust!.plane.normal.dot(normal)), 1.0, accuracy: 1e-3)
        XCTAssertEqual(robust!.plane.intersection(rayDirection: Vec3(0, 0, 1))!.z, 2.0, accuracy: 0.01)
    }

    /// 「0.2mm を測るには何 m まで近づくか」の計算。
    /// iPhone 12MP 相当（f≈3000px）だと 0.2m まで寄る必要がある、という現実を確認する。
    func testCaptureAdvisorDistances() {
        let k12MP = CameraIntrinsics(fx: 3000, fy: 3000, cx: 2016, cy: 1512, imageWidth: 4032, imageHeight: 3024)
        let d = CaptureAdvisor.maximumDistance(forCrackWidthMM: 0.2, intrinsics: k12MP)
        XCTAssertEqual(d, 0.2, accuracy: 0.01)

        let k48MP = CameraIntrinsics(fx: 6000, fy: 6000, cx: 4032, cy: 3024, imageWidth: 8064, imageHeight: 6048)
        let d48 = CaptureAdvisor.maximumDistance(forCrackWidthMM: 0.2, intrinsics: k48MP)
        XCTAssertEqual(d48, 0.4, accuracy: 0.01)

        let minWidth = CaptureAdvisor.minimumMeasurableWidthMM(atDistance: 1.0, intrinsics: k48MP)
        XCTAssertEqual(minWidth, 0.5, accuracy: 0.01)
    }
}
