import Foundation

/// 画面でなぞった線（折れ線）と点の関係。なぞり計測の「近傍」と「区間」を決める。
struct StrokePath {
    let points: [Vec2]
    /// 各頂点までの弧長
    let cumulative: [Double]

    init(points: [Vec2]) {
        // 重複点を落とす（長さ 0 の線分は射影が定義できない）
        var cleaned: [Vec2] = []
        for p in points where cleaned.last.map({ $0.distance(to: p) > 1e-9 }) ?? true {
            cleaned.append(p)
        }
        self.points = cleaned
        var acc = [0.0]
        for i in 1..<max(1, cleaned.count) {
            acc.append(acc[i - 1] + cleaned[i - 1].distance(to: cleaned[i]))
        }
        self.cumulative = acc
    }

    var length: Double { cumulative.last ?? 0 }

    /// 線分 i 上の射影パラメータ t（クランプなし）と垂直距離
    private func projection(onSegment i: Int, of p: Vec2) -> (t: Double, distance: Double) {
        let a = points[i], b = points[i + 1]
        let ab = b - a
        let t = (p - a).dot(ab) / ab.lengthSquared
        let foot = a + ab * min(1, max(0, t))
        return (t, p.distance(to: foot))
    }

    /// なぞった区間の中（端の外ではない）で、線から radius 以内にあるか。
    ///
    /// 端に丸いキャップを付けないので、なぞった区間の外へは広がらない。
    /// 折れ線の内側の角は隣の線分が拾う。
    func containsInCorridor(_ p: Vec2, radius: Double) -> Bool {
        guard points.count >= 2 else { return false }
        for i in 0..<(points.count - 1) {
            let (t, d) = projection(onSegment: i, of: p)
            if t >= 0, t <= 1, d <= radius { return true }
        }
        return false
    }

    /// 最も近い点までの距離（端はクランプ）
    func distance(to p: Vec2) -> Double {
        guard points.count >= 2 else { return points.first?.distance(to: p) ?? .infinity }
        var best = Double.infinity
        for i in 0..<(points.count - 1) {
            best = min(best, projection(onSegment: i, of: p).distance)
        }
        return best
    }

    /// 最も近い点の弧長 s（0...length）
    func arcLength(nearestTo p: Vec2) -> Double {
        guard points.count >= 2 else { return 0 }
        var best = Double.infinity
        var s = 0.0
        for i in 0..<(points.count - 1) {
            let (t, d) = projection(onSegment: i, of: p)
            if d < best {
                best = d
                let tc = min(1, max(0, t))
                s = cumulative[i] + tc * (cumulative[i + 1] - cumulative[i])
            }
        }
        return s
    }
}
