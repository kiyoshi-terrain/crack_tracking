import Foundation

/// カメラ座標系における平面（壁面）。
public struct Plane: Equatable, Codable, Sendable {
    /// 単位法線ベクトル
    public var normal: Vec3
    /// 原点から平面までの符号付き距離（`normal · p = distance` を満たす）
    public var distance: Double

    public init(normal: Vec3, distance: Double) {
        self.normal = normal.normalized
        self.distance = distance
    }

    public init(point: Vec3, normal: Vec3) {
        let n = normal.normalized
        self.normal = n
        self.distance = n.dot(point)
    }

    /// カメラ正対（光軸に垂直）で距離 `depth` にある平面。
    /// LiDAR が使えない場合のフォールバック。
    public static func frontoParallel(depth: Double) -> Plane {
        Plane(normal: Vec3(0, 0, -1), distance: -depth)
    }

    /// 原点から `direction` 方向に伸ばした光線と平面の交点。
    public func intersection(rayDirection direction: Vec3) -> Vec3? {
        let denom = normal.dot(direction)
        guard abs(denom) > 1e-9 else { return nil }
        let t = distance / denom
        guard t > 0 else { return nil }
        return direction * t
    }

    public func signedDistance(to point: Vec3) -> Double {
        normal.dot(point) - distance
    }
}

/// 3D点群への最小二乗平面フィッティング。
///
/// LiDAR デプスマップから壁面の姿勢を求めるのに使います。共分散行列の
/// 最小固有値に対応する固有ベクトルが法線になります。
public enum PlaneFitter {
    public struct Result: Sendable {
        public let plane: Plane
        /// 平面からの残差 RMS（m）。大きい場合は壁面が平面でない/ノイズが多い。
        public let rmsResidual: Double
        /// 平面性の指標: 最小固有値 / 中間固有値。0 に近いほど良い平面。
        public let planarity: Double
        public let pointCount: Int
    }

    public static func fit(points: [Vec3]) -> Result? {
        guard points.count >= 3 else { return nil }

        var centroid = Vec3.zero
        for p in points { centroid = centroid + p }
        centroid = centroid / Double(points.count)

        var xx = 0.0, xy = 0.0, xz = 0.0, yy = 0.0, yz = 0.0, zz = 0.0
        for p in points {
            let d = p - centroid
            xx += d.x * d.x
            xy += d.x * d.y
            xz += d.x * d.z
            yy += d.y * d.y
            yz += d.y * d.z
            zz += d.z * d.z
        }
        let n = Double(points.count)
        let cov = SymmetricMatrix3(
            xx: xx / n, xy: xy / n, xz: xz / n,
            yy: yy / n, yz: yz / n, zz: zz / n
        )

        let eigen = cov.eigenDecomposition()
        // 固有値は昇順。最小固有値の固有ベクトルが法線。
        var normal = eigen.vectors[0]
        // 法線をカメラ側（-Z 方向）へ向けておくと符号の扱いが安定する。
        if normal.z > 0 { normal = -normal }

        let plane = Plane(point: centroid, normal: normal)

        var sumSq = 0.0
        for p in points {
            let d = plane.signedDistance(to: p)
            sumSq += d * d
        }
        let rms = (sumSq / n).squareRoot()
        let planarity = eigen.values[1] > 1e-12 ? eigen.values[0] / eigen.values[1] : 1.0

        return Result(plane: plane, rmsResidual: rms, planarity: planarity, pointCount: points.count)
    }

    /// 外れ値（配管・樹木・デプスの飛び）を落としながら平面を求める。
    ///
    /// ## なぜ PCA をそのまま反復しないのか
    ///
    /// `fit` は全方向の残差を最小化する（主成分分析）ため、**外れ値によって
    /// Z 方向の分散が X/Y 方向の分散を超えると、最小固有ベクトルが入れ替わって
    /// 法線が 90° 回ります。** ROI が 40cm 角、外れ値が 7% でもこれは起こり、
    /// 一度そうなると反復しても復帰できません。
    ///
    /// ## 代わりにやっていること
    ///
    /// デプスマップから平面を取る場面では、対象面は必ずカメラの正面を向いています。
    /// そこで `z = ax + by + c` の回帰（Z 方向の残差だけを最小化）を使います。
    /// この定式化では法線が `(a, b, -1)` の形に固定されるため、**構造的に
    /// 90° 回りようがありません。**
    ///
    /// 残差の MAD（中央絶対偏差）でロバストに外れ値を落とし、
    /// 最後に残ったインライアへ `fit` を適用して平面性の指標も得ます。
    ///
    /// - Parameters:
    ///   - outlierSigma: MAD から換算した標準偏差の何倍までを採用するか
    ///   - residualFloor: しきい値の下限（m）。全点が完全に同一平面だと
    ///     MAD が 0 になり、丸め誤差だけで点が落ちるのを防ぐ。
    public static func fitRobust(
        points: [Vec3],
        iterations: Int = 4,
        outlierSigma: Double = 3.0,
        residualFloor: Double = 0.003
    ) -> Result? {
        guard points.count >= 8 else { return fit(points: points) }

        var current = points
        for _ in 0..<iterations {
            guard let plane = solveDepthPlane(current) else { break }

            var residuals = [Double]()
            residuals.reserveCapacity(current.count)
            for p in current {
                residuals.append(p.z - (plane.a * p.x + plane.b * p.y + plane.c))
            }

            let center = median(residuals)
            let mad = median(residuals.map { abs($0 - center) })
            let threshold = max(1.4826 * mad * outlierSigma, residualFloor)

            var kept = [Vec3]()
            kept.reserveCapacity(current.count)
            for (point, residual) in zip(current, residuals) where abs(residual - center) <= threshold {
                kept.append(point)
            }

            // 落としすぎ / もう落ちない、のどちらかで打ち切る
            guard kept.count >= max(3, points.count / 10), kept.count < current.count else { break }
            current = kept
        }

        return fit(points: current)
    }

    /// `z = ax + by + c` の最小二乗解。
    ///
    /// 重心を引いてから解くことで、正規方程式が 2x2 に落ちて条件数も良くなります。
    static func solveDepthPlane(_ points: [Vec3]) -> (a: Double, b: Double, c: Double)? {
        let n = Double(points.count)
        guard n >= 3 else { return nil }

        var cx = 0.0, cy = 0.0, cz = 0.0
        for p in points {
            cx += p.x
            cy += p.y
            cz += p.z
        }
        cx /= n
        cy /= n
        cz /= n

        var sxx = 0.0, sxy = 0.0, syy = 0.0, sxz = 0.0, syz = 0.0
        for p in points {
            let dx = p.x - cx
            let dy = p.y - cy
            let dz = p.z - cz
            sxx += dx * dx
            sxy += dx * dy
            syy += dy * dy
            sxz += dx * dz
            syz += dy * dz
        }

        let det = sxx * syy - sxy * sxy
        // 相対的な条件判定。ROI が一方向に潰れている（線状）と解けない。
        guard det > 1e-9 * max(sxx * syy, 1e-12) else { return nil }

        let a = (syy * sxz - sxy * syz) / det
        let b = (sxx * syz - sxy * sxz) / det
        let c = cz - a * cx - b * cy
        return (a, b, c)
    }

    static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        return sorted.count % 2 == 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    }
}

/// 3x3 対称行列（共分散行列用）とヤコビ法による固有値分解。
struct SymmetricMatrix3 {
    var xx: Double, xy: Double, xz: Double
    var yy: Double, yz: Double, zz: Double

    struct Eigen {
        /// 昇順の固有値
        let values: [Double]
        /// 対応する固有ベクトル
        let vectors: [Vec3]
    }

    func eigenDecomposition(sweeps: Int = 24) -> Eigen {
        var a = [[Double]](repeating: [Double](repeating: 0, count: 3), count: 3)
        a[0] = [xx, xy, xz]
        a[1] = [xy, yy, yz]
        a[2] = [xz, yz, zz]

        var v = [[Double]](repeating: [Double](repeating: 0, count: 3), count: 3)
        for i in 0..<3 { v[i][i] = 1 }

        for _ in 0..<sweeps {
            var off = 0.0
            for p in 0..<3 {
                for q in (p + 1)..<3 { off += a[p][q] * a[p][q] }
            }
            if off < 1e-24 { break }

            for p in 0..<2 {
                for q in (p + 1)..<3 {
                    guard abs(a[p][q]) > 1e-18 else { continue }
                    let theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
                    let t = (theta >= 0 ? 1.0 : -1.0) / (abs(theta) + (theta * theta + 1).squareRoot())
                    let c = 1 / (t * t + 1).squareRoot()
                    let s = t * c

                    for k in 0..<3 {
                        let akp = a[k][p], akq = a[k][q]
                        a[k][p] = c * akp - s * akq
                        a[k][q] = s * akp + c * akq
                    }
                    for k in 0..<3 {
                        let apk = a[p][k], aqk = a[q][k]
                        a[p][k] = c * apk - s * aqk
                        a[q][k] = s * apk + c * aqk
                    }
                    for k in 0..<3 {
                        let vkp = v[k][p], vkq = v[k][q]
                        v[k][p] = c * vkp - s * vkq
                        v[k][q] = s * vkp + c * vkq
                    }
                }
            }
        }

        var pairs: [(Double, Vec3)] = (0..<3).map { i in
            (a[i][i], Vec3(v[0][i], v[1][i], v[2][i]).normalized)
        }
        pairs.sort { $0.0 < $1.0 }
        return Eigen(values: pairs.map { $0.0 }, vectors: pairs.map { $0.1 })
    }
}
