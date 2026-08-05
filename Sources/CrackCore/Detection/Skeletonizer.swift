import Foundation

/// Zhang-Suen 細線化アルゴリズム。
///
/// 非極大抑制の後でもヒステリシスの伸長で線が2〜3px に太る箇所が残るため、
/// 芯線を1px に揃えてからポリライン化します。
public enum Skeletonizer {

    public static func thin(_ mask: BinaryMask, maxIterations: Int = 64) -> BinaryMask {
        var current = mask
        let w = mask.width, h = mask.height
        guard w > 2, h > 2 else { return mask }

        for _ in 0..<maxIterations {
            var changed = false
            for step in 0..<2 {
                var toRemove: [Int] = []
                for y in 1..<(h - 1) {
                    for x in 1..<(w - 1) {
                        guard current[x, y] else { continue }
                        let p = neighbors(current, x: x, y: y)
                        let b = p.reduce(0) { $0 + ($1 ? 1 : 0) }
                        guard b >= 2, b <= 6 else { continue }
                        guard transitions(p) == 1 else { continue }

                        // p = [P2(N), P3(NE), P4(E), P5(SE), P6(S), P7(SW), P8(W), P9(NW)]
                        let n = p[0], e = p[2], s = p[4], west = p[6]
                        if step == 0 {
                            guard !(n && e && s) else { continue }
                            guard !(e && s && west) else { continue }
                        } else {
                            guard !(n && e && west) else { continue }
                            guard !(n && s && west) else { continue }
                        }
                        toRemove.append(y * w + x)
                    }
                }
                if !toRemove.isEmpty {
                    changed = true
                    for i in toRemove { current.values[i] = false }
                }
            }
            if !changed { break }
        }
        return current
    }

    /// 時計回りの8近傍（N から開始）。
    @inline(__always)
    static func neighbors(_ m: BinaryMask, x: Int, y: Int) -> [Bool] {
        [
            m.at(x, y - 1),     // P2 N
            m.at(x + 1, y - 1), // P3 NE
            m.at(x + 1, y),     // P4 E
            m.at(x + 1, y + 1), // P5 SE
            m.at(x, y + 1),     // P6 S
            m.at(x - 1, y + 1), // P7 SW
            m.at(x - 1, y),     // P8 W
            m.at(x - 1, y - 1), // P9 NW
        ]
    }

    /// 0→1 の遷移回数（連結性の判定に使う）。
    @inline(__always)
    static func transitions(_ p: [Bool]) -> Int {
        var count = 0
        for i in 0..<p.count {
            let a = p[i]
            let b = p[(i + 1) % p.count]
            if !a && b { count += 1 }
        }
        return count
    }

    /// 8近傍の連結数。1=端点, 2=通常, 3以上=分岐点。
    public static func neighborCount(_ mask: BinaryMask, x: Int, y: Int) -> Int {
        neighbors(mask, x: x, y: y).reduce(0) { $0 + ($1 ? 1 : 0) }
    }
}
