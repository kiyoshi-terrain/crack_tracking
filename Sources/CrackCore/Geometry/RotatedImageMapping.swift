import Foundation

/// 表示用に 90° 単位で回した画像と、元画像の画素座標の対応。
///
/// ARKit のキャプチャ画像は常に横長で、縦持ちでは 90° 回して表示する。
/// 静止画の上で指がなぞった座標は**回した画像**の座標なので、計測に渡す前に
/// 元画像の座標へ戻す必要がある。ここを暗算で書くと軸を取り違えるので、
/// 往復が一致することをテストで固定した一箇所に集める。
///
/// 座標は画素中心を整数に置く連続座標（画素 (0,0) の中心が (0,0)）。
public struct RotatedImageMapping: Equatable, Sendable {
    /// 元画像の画素数
    public let rawWidth: Int
    public let rawHeight: Int
    /// 時計回りの 90° 回転の回数（0...3）。縦持ちは 1
    public let quarterTurnsClockwise: Int

    public init(rawWidth: Int, rawHeight: Int, quarterTurnsClockwise: Int) {
        self.rawWidth = rawWidth
        self.rawHeight = rawHeight
        self.quarterTurnsClockwise = ((quarterTurnsClockwise % 4) + 4) % 4
    }

    /// 回した画像の画素数
    public var rotatedWidth: Int { quarterTurnsClockwise % 2 == 0 ? rawWidth : rawHeight }
    public var rotatedHeight: Int { quarterTurnsClockwise % 2 == 0 ? rawHeight : rawWidth }

    /// 元画像の座標 → 回した画像の座標
    public func toRotated(_ p: Vec2) -> Vec2 {
        let w = Double(rawWidth - 1)
        let h = Double(rawHeight - 1)
        switch quarterTurnsClockwise {
        case 1: return Vec2(h - p.y, p.x)          // 90° 時計回り: 左上 → 右上
        case 2: return Vec2(w - p.x, h - p.y)      // 180°
        case 3: return Vec2(p.y, w - p.x)          // 90° 反時計回り: 左上 → 左下
        default: return p
        }
    }

    /// 回した画像の座標 → 元画像の座標
    public func toRaw(_ p: Vec2) -> Vec2 {
        let w = Double(rawWidth - 1)
        let h = Double(rawHeight - 1)
        switch quarterTurnsClockwise {
        case 1: return Vec2(p.y, h - p.x)
        case 2: return Vec2(w - p.x, h - p.y)
        case 3: return Vec2(w - p.y, p.x)
        default: return p
        }
    }
}
