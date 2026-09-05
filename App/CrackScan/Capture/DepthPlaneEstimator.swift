import ARKit
import CoreVideo
import Foundation
import CrackCore

/// LiDAR のデプスマップから対象壁面の平面を推定する。
///
/// 本アプリの精度はここに懸かっています。写真だけでは「1px 何 mm か」が
/// 決まらないため、LiDAR で得た壁面の距離と傾きをスケールの基準にします。
public enum DepthPlaneEstimator {

    public struct Estimate {
        /// カメラ座標系（X=右, Y=下, Z=前方）の平面
        public let plane: Plane
        /// フィッティング残差 RMS（m）
        public let rmsResidual: Double
        /// 使用した点数
        public let sampleCount: Double
        /// ROI 中心の距離（m）
        public let centerDistance: Double
    }

    /// 指定した画像上の矩形領域に対応するデプスから平面を求める。
    ///
    /// - Parameters:
    ///   - frame: ARKit フレーム（`sceneDepth` が必要）
    ///   - normalizedRegion: キャプチャ画像に対する正規化矩形（0...1）
    ///   - minimumConfidence: 採用するデプス信頼度の下限
    public static func estimate(
        frame: ARFrame,
        normalizedRegion: CGRect,
        minimumConfidence: ARConfidenceLevel = .medium,
        maxSamplesPerAxis: Int = 48
    ) -> Estimate? {
        guard let sceneDepth = frame.smoothedSceneDepth ?? frame.sceneDepth else { return nil }
        let depthMap = sceneDepth.depthMap
        let confidenceMap = sceneDepth.confidenceMap

        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(depthMap, .readOnly) }
        if let c = confidenceMap { CVPixelBufferLockBaseAddress(c, .readOnly) }
        defer { if let c = confidenceMap { CVPixelBufferUnlockBaseAddress(c, .readOnly) } }

        let depthWidth = CVPixelBufferGetWidth(depthMap)
        let depthHeight = CVPixelBufferGetHeight(depthMap)
        guard let depthBase = CVPixelBufferGetBaseAddress(depthMap) else { return nil }
        let depthStride = CVPixelBufferGetBytesPerRow(depthMap)

        // デプスマップ解像度での内部パラメータ
        let fullIntrinsics = cameraIntrinsics(frame: frame)
        let intrinsics = fullIntrinsics.scaled(toWidth: depthWidth, height: depthHeight)

        let x0 = max(0, Int(normalizedRegion.minX * CGFloat(depthWidth)))
        let x1 = min(depthWidth, Int(normalizedRegion.maxX * CGFloat(depthWidth)))
        let y0 = max(0, Int(normalizedRegion.minY * CGFloat(depthHeight)))
        let y1 = min(depthHeight, Int(normalizedRegion.maxY * CGFloat(depthHeight)))
        guard x1 > x0, y1 > y0 else { return nil }

        let stepX = max(1, (x1 - x0) / maxSamplesPerAxis)
        let stepY = max(1, (y1 - y0) / maxSamplesPerAxis)

        var points: [Vec3] = []
        points.reserveCapacity(((x1 - x0) / stepX + 1) * ((y1 - y0) / stepY + 1))

        var confidenceBase: UnsafeMutableRawPointer?
        var confidenceStride = 0
        if let c = confidenceMap {
            confidenceBase = CVPixelBufferGetBaseAddress(c)
            confidenceStride = CVPixelBufferGetBytesPerRow(c)
        }

        for y in stride(from: y0, to: y1, by: stepY) {
            let depthRow = depthBase.advanced(by: y * depthStride).assumingMemoryBound(to: Float32.self)
            let confidenceRow = confidenceBase?.advanced(by: y * confidenceStride).assumingMemoryBound(to: UInt8.self)
            for x in stride(from: x0, to: x1, by: stepX) {
                if let row = confidenceRow, Int(row[x]) < minimumConfidence.rawValue { continue }
                let d = depthRow[x]
                guard d.isFinite, d > 0.05, d < 8.0 else { continue }
                points.append(intrinsics.unproject(pixel: Vec2(Double(x), Double(y)), depth: Double(d)))
            }
        }

        guard points.count >= 32, let fit = PlaneFitter.fitRobust(points: points) else { return nil }

        let center = Vec2(
            Double(normalizedRegion.midX) * Double(fullIntrinsics.imageWidth),
            Double(normalizedRegion.midY) * Double(fullIntrinsics.imageHeight)
        )
        let centerRay = fullIntrinsics.viewRay(through: center)
        let centerDistance = fit.plane.intersection(rayDirection: centerRay)?.z ?? 0

        return Estimate(
            plane: fit.plane,
            rmsResidual: fit.rmsResidual,
            sampleCount: Double(fit.pointCount),
            centerDistance: centerDistance
        )
    }

    /// `ARFrame` の内部パラメータを `CameraIntrinsics` に変換する。
    ///
    /// ARKit の `intrinsics` は列優先の simd_float3x3 で、キャプチャ画像
    /// （常に横長）の解像度に対応します。
    ///
    /// 高解像度フレームでは `camera.imageResolution` と `capturedImage` の画素数が
    /// 食い違う可能性に備え、**実際の画素バッファの寸法**に合わせて拡縮します。
    /// 内部パラメータは画素数に比例するので、ここがずれると mm/px がそのまま倍率分ずれます。
    public static func cameraIntrinsics(frame: ARFrame) -> CameraIntrinsics {
        let m = frame.camera.intrinsics
        let resolution = frame.camera.imageResolution
        let intrinsics = CameraIntrinsics(
            fx: Double(m[0][0]),
            fy: Double(m[1][1]),
            cx: Double(m[2][0]),
            cy: Double(m[2][1]),
            imageWidth: Int(resolution.width),
            imageHeight: Int(resolution.height)
        )
        let buffer = frame.capturedImageSize
        let bufferWidth = Int(buffer.width)
        let bufferHeight = Int(buffer.height)
        guard bufferWidth > 0, bufferHeight > 0,
              bufferWidth != intrinsics.imageWidth || bufferHeight != intrinsics.imageHeight else {
            return intrinsics
        }
        return intrinsics.scaled(toWidth: bufferWidth, height: bufferHeight)
    }

    /// 画像系カメラ座標（X=右, Y=下, Z=前方）の点を ARKit のワールド座標へ変換する。
    ///
    /// ARKit のカメラ座標は X=右, Y=上, Z=後方 なので、Y と Z の符号を反転してから
    /// `camera.transform` を掛けます。ここを間違えると 3D 位置だけが上下逆になります。
    public static func worldPosition(
        ofCameraPoint point: Vec3,
        frame: ARFrame
    ) -> Vec3 {
        let arkitCameraPoint = simd_float4(
            Float(point.x),
            Float(-point.y),
            Float(-point.z),
            1
        )
        let world = frame.camera.transform * arkitCameraPoint
        return Vec3(Double(world.x), Double(world.y), Double(world.z))
    }
}

extension ARFrame {
    /// `capturedImage` の実際の画素数。解析・オーバーレイの座標系はこれに合わせる
    /// （`camera.imageResolution` ではなく）。
    var capturedImageSize: CGSize {
        CGSize(
            width: CVPixelBufferGetWidth(capturedImage),
            height: CVPixelBufferGetHeight(capturedImage)
        )
    }
}
