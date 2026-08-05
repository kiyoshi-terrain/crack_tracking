import Foundation

/// 細線化されたマスクを、順序付きの点列（ポリライン）へ変換する。
///
/// ひび割れは枝分かれするので、分岐点で切って「枝」単位のポリラインを作り、
/// 短いヒゲ（スパー）を落としてから平滑化・間引きを行います。
public enum PolylineTracer {

    public struct Options: Sendable {
        /// これより短い枝（px）は分岐由来のヒゲとみなして捨てる
        public var minBranchLengthPx: Double
        /// Douglas-Peucker の許容誤差（px）
        public var simplifyTolerancePx: Double
        /// 芯線の座標を平滑化する移動平均の半径（px）。法線方向を安定させる。
        public var smoothingRadius: Int

        public init(
            minBranchLengthPx: Double = 12,
            simplifyTolerancePx: Double = 0.6,
            smoothingRadius: Int = 2
        ) {
            self.minBranchLengthPx = minBranchLengthPx
            self.simplifyTolerancePx = simplifyTolerancePx
            self.smoothingRadius = smoothingRadius
        }

        public static let `default` = Options()
    }

    public static func trace(_ skeleton: BinaryMask, options: Options = .default) -> [[Vec2]] {
        let branches = rawBranches(skeleton)
        var result: [[Vec2]] = []
        for branch in branches {
            let points = branch.map { Vec2(Double($0.0), Double($0.1)) }
            guard polylineLength(points) >= options.minBranchLengthPx else { continue }
            var processed = smooth(points, radius: options.smoothingRadius)
            processed = simplify(processed, tolerance: options.simplifyTolerancePx)
            guard processed.count >= 2 else { continue }
            result.append(processed)
        }
        // 長い順に返す（主要なひび割れを先頭に）
        result.sort { polylineLength($0) > polylineLength($1) }
        return result
    }

    /// 端点・分岐点で区切った生の画素列を取り出す。
    static func rawBranches(_ mask: BinaryMask) -> [[(Int, Int)]] {
        let w = mask.width, h = mask.height
        var degree = [Int](repeating: 0, count: w * h)
        var nodes: [(Int, Int)] = []

        for y in 0..<h {
            for x in 0..<w where mask[x, y] {
                let d = Skeletonizer.neighborCount(mask, x: x, y: y)
                degree[y * w + x] = d
                if d != 2 { nodes.append((x, y)) }
            }
        }

        var visitedEdge = Set<Int64>()
        var branches: [[(Int, Int)]] = []

        func edgeKey(_ a: (Int, Int), _ b: (Int, Int)) -> Int64 {
            let ia = Int64(a.1 * w + a.0)
            let ib = Int64(b.1 * w + b.0)
            return ia < ib ? ia << 32 | ib : ib << 32 | ia
        }

        func neighborPixels(_ x: Int, _ y: Int) -> [(Int, Int)] {
            var out: [(Int, Int)] = []
            for dy in -1...1 {
                for dx in -1...1 {
                    if dx == 0 && dy == 0 { continue }
                    let nx = x + dx, ny = y + dy
                    if mask.at(nx, ny) { out.append((nx, ny)) }
                }
            }
            return out
        }

        /// ノードから出発して、次のノードに到達するまで辿る。
        func walk(from node: (Int, Int), toward first: (Int, Int)) -> [(Int, Int)] {
            var path: [(Int, Int)] = [node, first]
            var previous = node
            var current = first
            while degree[current.1 * w + current.0] == 2 {
                let next = neighborPixels(current.0, current.1).first {
                    !($0.0 == previous.0 && $0.1 == previous.1)
                }
                guard let n = next else { break }
                _ = visitedEdge.insert(edgeKey(current, n))
                path.append(n)
                previous = current
                current = n
            }
            return path
        }

        for node in nodes {
            for neighbor in neighborPixels(node.0, node.1) {
                let key = edgeKey(node, neighbor)
                if visitedEdge.contains(key) { continue }
                visitedEdge.insert(key)
                branches.append(walk(from: node, toward: neighbor))
            }
        }

        // ノードを1つも持たない閉ループ（degree が全部2）を拾う
        var consumed = Set<Int>()
        for branch in branches {
            for p in branch { consumed.insert(p.1 * w + p.0) }
        }
        for y in 0..<h {
            for x in 0..<w where mask[x, y] && !consumed.contains(y * w + x) {
                var loop: [(Int, Int)] = []
                var current = (x, y)
                var previous = (-1, -1)
                repeat {
                    loop.append(current)
                    consumed.insert(current.1 * w + current.0)
                    let next = neighborPixels(current.0, current.1).first {
                        !($0.0 == previous.0 && $0.1 == previous.1) && !consumed.contains($0.1 * w + $0.0)
                    }
                    guard let n = next else { break }
                    previous = current
                    current = n
                } while true
                if loop.count > 3 { branches.append(loop) }
            }
        }

        return branches
    }

    // MARK: - ポリライン処理

    public static func polylineLength(_ points: [Vec2]) -> Double {
        guard points.count >= 2 else { return 0 }
        var total = 0.0
        for i in 1..<points.count {
            total += points[i].distance(to: points[i - 1])
        }
        return total
    }

    /// 移動平均による平滑化（端点は固定）。
    public static func smooth(_ points: [Vec2], radius: Int) -> [Vec2] {
        guard radius > 0, points.count > radius * 2 + 1 else { return points }
        var out = points
        for i in 0..<points.count {
            let lo = max(0, i - radius)
            let hi = min(points.count - 1, i + radius)
            var sum = Vec2.zero
            for j in lo...hi { sum = sum + points[j] }
            out[i] = sum / Double(hi - lo + 1)
        }
        out[0] = points[0]
        out[out.count - 1] = points[points.count - 1]
        return out
    }

    /// Douglas-Peucker による間引き。
    public static func simplify(_ points: [Vec2], tolerance: Double) -> [Vec2] {
        guard points.count > 2, tolerance > 0 else { return points }
        var keep = [Bool](repeating: false, count: points.count)
        keep[0] = true
        keep[points.count - 1] = true

        var stack: [(Int, Int)] = [(0, points.count - 1)]
        while let (start, end) = stack.popLast() {
            guard end > start + 1 else { continue }
            var maxDistance = 0.0
            var index = start
            for i in (start + 1)..<end {
                let d = perpendicularDistance(points[i], from: points[start], to: points[end])
                if d > maxDistance {
                    maxDistance = d
                    index = i
                }
            }
            if maxDistance > tolerance {
                keep[index] = true
                stack.append((start, index))
                stack.append((index, end))
            }
        }
        var out: [Vec2] = []
        out.reserveCapacity(points.count)
        for (index, point) in points.enumerated() where keep[index] {
            out.append(point)
        }
        return out
    }

    static func perpendicularDistance(_ p: Vec2, from a: Vec2, to b: Vec2) -> Double {
        let ab = b - a
        let lengthSq = ab.lengthSquared
        guard lengthSq > 1e-12 else { return p.distance(to: a) }
        let t = min(1, max(0, (p - a).dot(ab) / lengthSq))
        let projection = a + ab * t
        return p.distance(to: projection)
    }

    /// ポリラインを一定間隔で再サンプリングする（幅計測の測点を等間隔にする）。
    public static func resample(_ points: [Vec2], spacing: Double) -> [Vec2] {
        guard points.count >= 2, spacing > 0 else { return points }
        var out: [Vec2] = [points[0]]
        var carry = 0.0
        for i in 1..<points.count {
            let a = points[i - 1]
            let b = points[i]
            let segmentLength = a.distance(to: b)
            guard segmentLength > 1e-9 else { continue }
            let direction = (b - a) / segmentLength
            var offset = spacing - carry
            while offset <= segmentLength {
                out.append(a + direction * offset)
                offset += spacing
            }
            carry = segmentLength - (offset - spacing)
        }
        if let last = points.last, let tail = out.last, tail.distance(to: last) > spacing * 0.25 {
            out.append(last)
        }
        return out
    }

    /// 各点における接線方向（前後の点から中央差分）。
    public static func tangents(_ points: [Vec2]) -> [Vec2] {
        guard points.count >= 2 else { return points.map { _ in Vec2(1, 0) } }
        var out = [Vec2](repeating: Vec2(1, 0), count: points.count)
        for i in 0..<points.count {
            let a = points[max(0, i - 1)]
            let b = points[min(points.count - 1, i + 1)]
            let t = (b - a).normalized
            out[i] = t.lengthSquared > 0 ? t : Vec2(1, 0)
        }
        return out
    }
}
