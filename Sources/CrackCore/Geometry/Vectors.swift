import Foundation

/// 2次元ベクトル（画像座標系: x=右, y=下）
public struct Vec2: Equatable, Hashable, Codable, Sendable {
    public var x: Double
    public var y: Double

    public init(_ x: Double, _ y: Double) {
        self.x = x
        self.y = y
    }

    public static let zero = Vec2(0, 0)

    public var length: Double { (x * x + y * y).squareRoot() }
    public var lengthSquared: Double { x * x + y * y }

    public var normalized: Vec2 {
        let l = length
        guard l > .ulpOfOne else { return .zero }
        return Vec2(x / l, y / l)
    }

    /// 反時計回りに90度回転したベクトル（亀裂の法線方向を求めるのに使う）
    public var perpendicular: Vec2 { Vec2(-y, x) }

    public func dot(_ other: Vec2) -> Double { x * other.x + y * other.y }
    public func cross(_ other: Vec2) -> Double { x * other.y - y * other.x }

    public func distance(to other: Vec2) -> Double { (self - other).length }

    public static func + (l: Vec2, r: Vec2) -> Vec2 { Vec2(l.x + r.x, l.y + r.y) }
    public static func - (l: Vec2, r: Vec2) -> Vec2 { Vec2(l.x - r.x, l.y - r.y) }
    public static func * (l: Vec2, r: Double) -> Vec2 { Vec2(l.x * r, l.y * r) }
    public static func * (l: Double, r: Vec2) -> Vec2 { r * l }
    public static func / (l: Vec2, r: Double) -> Vec2 { Vec2(l.x / r, l.y / r) }
    public static prefix func - (v: Vec2) -> Vec2 { Vec2(-v.x, -v.y) }
}

/// 3次元ベクトル
///
/// 本ライブラリ内では「画像系カメラ座標」を標準とします。
/// X = 右, Y = 下, Z = 前方（光軸方向, 奥行きが正）。
/// ARKit のカメラ座標系（X=右, Y=上, Z=後方）とは Y/Z の符号が反転するため、
/// 変換は `CameraPose` 側で明示的に行います。
public struct Vec3: Equatable, Hashable, Codable, Sendable {
    public var x: Double
    public var y: Double
    public var z: Double

    public init(_ x: Double, _ y: Double, _ z: Double) {
        self.x = x
        self.y = y
        self.z = z
    }

    public static let zero = Vec3(0, 0, 0)

    public var length: Double { (x * x + y * y + z * z).squareRoot() }
    public var lengthSquared: Double { x * x + y * y + z * z }

    public var normalized: Vec3 {
        let l = length
        guard l > .ulpOfOne else { return .zero }
        return Vec3(x / l, y / l, z / l)
    }

    public func dot(_ other: Vec3) -> Double { x * other.x + y * other.y + z * other.z }

    public func cross(_ other: Vec3) -> Vec3 {
        Vec3(
            y * other.z - z * other.y,
            z * other.x - x * other.z,
            x * other.y - y * other.x
        )
    }

    public func distance(to other: Vec3) -> Double { (self - other).length }

    public static func + (l: Vec3, r: Vec3) -> Vec3 { Vec3(l.x + r.x, l.y + r.y, l.z + r.z) }
    public static func - (l: Vec3, r: Vec3) -> Vec3 { Vec3(l.x - r.x, l.y - r.y, l.z - r.z) }
    public static func * (l: Vec3, r: Double) -> Vec3 { Vec3(l.x * r, l.y * r, l.z * r) }
    public static func * (l: Double, r: Vec3) -> Vec3 { r * l }
    public static func / (l: Vec3, r: Double) -> Vec3 { Vec3(l.x / r, l.y / r, l.z / r) }
    public static prefix func - (v: Vec3) -> Vec3 { Vec3(-v.x, -v.y, -v.z) }
}
