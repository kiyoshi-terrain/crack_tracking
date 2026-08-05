import Foundation

/// 撮影計画（何枚、どの間隔で撮れば壁面全体を必要分解能で覆えるか）。
///
/// 写真測量では隣接写真のオーバーラップが足りないと点群が破綻します。
/// 航空写真測量の慣行に倣い、進行方向 80%・隣接コース 60% を既定とします。
public struct CapturePlan: Sendable {
    /// 1枚がカバーする壁面上の範囲（m）
    public let footprintWidth: Double
    public let footprintHeight: Double
    /// 撮影間隔（m）
    public let stepAlong: Double
    public let stepAcross: Double
    /// 必要撮影距離（m）
    public let distance: Double
    /// 達成される GSD（mm/px）
    public let gsdMM: Double
    /// 対象範囲を覆うのに必要な枚数
    public let columns: Int
    public let rows: Int

    public var totalShots: Int { columns * rows }

    /// 壁面座標（左下原点, m）での各撮影位置。
    public func stationPositions() -> [Vec2] {
        var out: [Vec2] = []
        for r in 0..<rows {
            for c in 0..<columns {
                out.append(Vec2(Double(c) * stepAlong + footprintWidth / 2,
                                Double(r) * stepAcross + footprintHeight / 2))
            }
        }
        return out
    }
}

public enum CoveragePlanner {

    /// 目標ひび割れ幅と対象範囲から撮影計画を立てる。
    public static func plan(
        targetCrackWidthMM: Double,
        areaWidth: Double,
        areaHeight: Double,
        intrinsics: CameraIntrinsics,
        forwardOverlap: Double = 0.8,
        sideOverlap: Double = 0.6,
        minimumPixelsAcrossCrack: Double = CaptureAdvisor.defaultMinimumPixelsAcrossCrack
    ) -> CapturePlan {
        let distance = CaptureAdvisor.maximumDistance(
            forCrackWidthMM: targetCrackWidthMM,
            intrinsics: intrinsics,
            minimumPixels: minimumPixelsAcrossCrack
        )
        let gsdMM = distance * 1000.0 / min(intrinsics.fx, intrinsics.fy)

        let footprintWidth = Double(intrinsics.imageWidth) * gsdMM / 1000.0
        let footprintHeight = Double(intrinsics.imageHeight) * gsdMM / 1000.0

        let stepAlong = max(0.01, footprintWidth * (1 - forwardOverlap))
        let stepAcross = max(0.01, footprintHeight * (1 - sideOverlap))

        let columns = max(1, Int(ceil(max(0, areaWidth - footprintWidth) / stepAlong)) + 1)
        let rows = max(1, Int(ceil(max(0, areaHeight - footprintHeight) / stepAcross)) + 1)

        return CapturePlan(
            footprintWidth: footprintWidth,
            footprintHeight: footprintHeight,
            stepAlong: stepAlong,
            stepAcross: stepAcross,
            distance: distance,
            gsdMM: gsdMM,
            columns: columns,
            rows: rows
        )
    }
}

/// 撮影済み範囲の追跡。壁面をグリッドに切り、撮れた場所を塗っていく。
public struct CoverageTracker: Sendable {
    public let cellSize: Double
    public let columns: Int
    public let rows: Int
    /// 各セルが何枚の写真に写ったか
    public private(set) var counts: [Int]

    public init(areaWidth: Double, areaHeight: Double, cellSize: Double = 0.05) {
        self.cellSize = max(0.01, cellSize)
        self.columns = max(1, Int(ceil(areaWidth / self.cellSize)))
        self.rows = max(1, Int(ceil(areaHeight / self.cellSize)))
        self.counts = [Int](repeating: 0, count: columns * rows)
    }

    /// 撮影1枚分のフットプリント（壁面座標, m）を記録する。
    public mutating func record(footprintOrigin origin: Vec2, width: Double, height: Double) {
        let x0 = max(0, Int(floor(origin.x / cellSize)))
        let y0 = max(0, Int(floor(origin.y / cellSize)))
        let x1 = min(columns - 1, Int(ceil((origin.x + width) / cellSize)))
        let y1 = min(rows - 1, Int(ceil((origin.y + height) / cellSize)))
        guard x0 <= x1, y0 <= y1 else { return }
        for y in y0...y1 {
            for x in x0...x1 {
                counts[y * columns + x] += 1
            }
        }
    }

    /// 1枚以上撮れているセルの割合。
    public var coverageRatio: Double {
        guard !counts.isEmpty else { return 0 }
        let covered = counts.reduce(0) { $0 + ($1 > 0 ? 1 : 0) }
        return Double(covered) / Double(counts.count)
    }

    /// 写真測量に必要な多重度（既定3枚以上）を満たすセルの割合。
    public func redundancyRatio(minimumShots: Int = 3) -> Double {
        guard !counts.isEmpty else { return 0 }
        let ok = counts.reduce(0) { $0 + ($1 >= minimumShots ? 1 : 0) }
        return Double(ok) / Double(counts.count)
    }

    /// まだ撮れていないセルの中心座標（壁面座標, m）。次に向かう場所の提示に使う。
    public func uncoveredCenters(limit: Int = 32) -> [Vec2] {
        var out: [Vec2] = []
        for y in 0..<rows {
            for x in 0..<columns where counts[y * columns + x] == 0 {
                out.append(Vec2((Double(x) + 0.5) * cellSize, (Double(y) + 0.5) * cellSize))
                if out.count >= limit { return out }
            }
        }
        return out
    }
}
