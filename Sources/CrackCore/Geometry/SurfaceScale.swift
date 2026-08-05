import Foundation

/// 画素 → 実寸（mm）の換算器。
///
/// 「1px 何 mm か」は画面内で一定ではありません。壁面を斜めから撮ると、
/// 傾いている方向のスケールだけが 1/cosθ で伸びます。ここでは平面と視線の
/// 交点を実際に計算して距離を測ることで、その異方性を近似なしで扱います。
public struct SurfaceScale: Sendable {
    public let intrinsics: CameraIntrinsics
    /// カメラ座標系における対象壁面
    public let plane: Plane

    public init(intrinsics: CameraIntrinsics, plane: Plane) {
        self.intrinsics = intrinsics
        self.plane = plane
    }

    /// LiDAR が無い/信頼できない場合の正対仮定フォールバック。
    public static func frontoParallel(intrinsics: CameraIntrinsics, depth: Double) -> SurfaceScale {
        SurfaceScale(intrinsics: intrinsics, plane: .frontoParallel(depth: depth))
    }

    /// 画素に対応する壁面上の3D点（カメラ座標系, m）。
    public func worldPoint(at pixel: Vec2) -> Vec3? {
        plane.intersection(rayDirection: intrinsics.viewRay(through: pixel))
    }

    /// 2つの画素間の壁面上での実距離（m）。
    public func surfaceDistance(from a: Vec2, to b: Vec2) -> Double? {
        guard let pa = worldPoint(at: a), let pb = worldPoint(at: b) else { return nil }
        return pa.distance(to: pb)
    }

    /// 指定画素・指定方向における 1px あたりの実寸（mm/px）。
    ///
    /// `direction` は画像座標系の単位ベクトル。亀裂幅を測るときは
    /// 亀裂に直交する方向を渡します。
    public func millimetersPerPixel(at pixel: Vec2, direction: Vec2) -> Double? {
        let d = direction.normalized
        guard d.lengthSquared > 0 else { return nil }
        let half = d * 0.5
        guard let p1 = worldPoint(at: pixel + half),
              let p2 = worldPoint(at: pixel - half) else { return nil }
        return p1.distance(to: p2) * 1000.0
    }

    /// 方向を問わない代表スケール（水平・垂直の幾何平均, mm/px）。
    /// 概算表示や品質判定に使う値で、幅計測には方向付きの値を使ってください。
    public func nominalMillimetersPerPixel(at pixel: Vec2) -> Double? {
        guard let sx = millimetersPerPixel(at: pixel, direction: Vec2(1, 0)),
              let sy = millimetersPerPixel(at: pixel, direction: Vec2(0, 1)) else { return nil }
        return (sx * sy).squareRoot()
    }

    /// 撮影距離（m）。
    public func distance(at pixel: Vec2) -> Double? {
        worldPoint(at: pixel)?.z
    }

    /// 入射角（度）: 視線と壁面法線のなす角。0°が正対。
    /// 40°を超えると幅計測の誤差とボケが急増するため撮り直しを促します。
    public func incidenceAngleDegrees(at pixel: Vec2) -> Double? {
        guard let p = worldPoint(at: pixel) else { return nil }
        let view = p.normalized
        let cosTheta = abs(view.dot(plane.normal))
        return acos(min(1, max(0, cosTheta))) * 180 / .pi
    }
}

/// 「その亀裂幅を測るには何 m まで近づけばよいか」を答えるヘルパー。
///
/// 写真測量でひび割れ幅を測る際の実務上の制約は、レンズ性能でも画素数でもなく
/// **GSD（地上分解能, mm/px）** です。幅 w のひび割れを安定して測るには
/// 最低でも 3px 程度に写っている必要があります。
public enum CaptureAdvisor {
    /// 幅計測に必要な最小画素数の既定値。
    /// 3px を下回るとハーフマックス法の幅推定がボケに支配され、過大評価になります。
    public static let defaultMinimumPixelsAcrossCrack: Double = 3.0

    /// 目標ひび割れ幅を測るために許容される最大 GSD（mm/px）。
    public static func maximumGSD(
        forCrackWidthMM widthMM: Double,
        minimumPixels: Double = defaultMinimumPixelsAcrossCrack
    ) -> Double {
        guard minimumPixels > 0 else { return .infinity }
        return widthMM / minimumPixels
    }

    /// 目標ひび割れ幅を測るための推奨最大撮影距離（m）。正対撮影を前提。
    public static func maximumDistance(
        forCrackWidthMM widthMM: Double,
        intrinsics: CameraIntrinsics,
        minimumPixels: Double = defaultMinimumPixelsAcrossCrack
    ) -> Double {
        let gsdMM = maximumGSD(forCrackWidthMM: widthMM, minimumPixels: minimumPixels)
        // GSD[mm/px] = distance[m] * 1000 / f[px]  →  distance = GSD * f / 1000
        let f = min(intrinsics.fx, intrinsics.fy)
        return gsdMM * f / 1000.0
    }

    /// ある距離で撮影したときに測定できる最小ひび割れ幅（mm）。
    public static func minimumMeasurableWidthMM(
        atDistance distance: Double,
        intrinsics: CameraIntrinsics,
        minimumPixels: Double = defaultMinimumPixelsAcrossCrack
    ) -> Double {
        let f = min(intrinsics.fx, intrinsics.fy)
        guard f > 0 else { return .infinity }
        let gsdMM = distance * 1000.0 / f
        return gsdMM * minimumPixels
    }
}
