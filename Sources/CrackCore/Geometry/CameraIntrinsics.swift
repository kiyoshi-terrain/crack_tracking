import Foundation

/// ピンホールカメラの内部パラメータ。
///
/// ARKit の `ARFrame.camera.intrinsics` はキャプチャ画像の解像度に対する値なので、
/// 計測用に画像を縮小した場合は必ず `scaled(toWidth:height:)` を通してください。
/// ここを忘れるとスケール（mm/px）がそのまま倍率分だけ狂います。
public struct CameraIntrinsics: Equatable, Codable, Sendable {
    /// 焦点距離（ピクセル単位）
    public var fx: Double
    public var fy: Double
    /// 主点（ピクセル単位）
    public var cx: Double
    public var cy: Double
    /// この内部パラメータが対応する画像サイズ
    public var imageWidth: Int
    public var imageHeight: Int

    public init(fx: Double, fy: Double, cx: Double, cy: Double, imageWidth: Int, imageHeight: Int) {
        self.fx = fx
        self.fy = fy
        self.cx = cx
        self.cy = cy
        self.imageWidth = imageWidth
        self.imageHeight = imageHeight
    }

    /// 画角（水平・度）
    public var horizontalFieldOfViewDegrees: Double {
        2 * atan(Double(imageWidth) / (2 * fx)) * 180 / .pi
    }

    /// 画像をリサイズした際に内部パラメータを追随させる。
    public func scaled(toWidth newWidth: Int, height newHeight: Int) -> CameraIntrinsics {
        guard imageWidth > 0, imageHeight > 0 else { return self }
        let sx = Double(newWidth) / Double(imageWidth)
        let sy = Double(newHeight) / Double(imageHeight)
        return CameraIntrinsics(
            fx: fx * sx,
            fy: fy * sy,
            cx: cx * sx,
            cy: cy * sy,
            imageWidth: newWidth,
            imageHeight: newHeight
        )
    }

    /// 画素座標から伸びる視線ベクトル（z = 1 に正規化された方向）を返す。
    public func viewRay(through pixel: Vec2) -> Vec3 {
        Vec3((pixel.x - cx) / fx, (pixel.y - cy) / fy, 1.0)
    }

    /// 画素と奥行き（m）からカメラ座標系の3D点を復元する。
    public func unproject(pixel: Vec2, depth: Double) -> Vec3 {
        Vec3((pixel.x - cx) * depth / fx, (pixel.y - cy) * depth / fy, depth)
    }

    /// カメラ座標系の3D点を画素へ投影する。カメラ後方の点は nil。
    public func project(_ point: Vec3) -> Vec2? {
        guard point.z > .ulpOfOne else { return nil }
        return Vec2(point.x * fx / point.z + cx, point.y * fy / point.z + cy)
    }

    public func contains(pixel: Vec2) -> Bool {
        pixel.x >= 0 && pixel.y >= 0 && pixel.x <= Double(imageWidth - 1) && pixel.y <= Double(imageHeight - 1)
    }
}
