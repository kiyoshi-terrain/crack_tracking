import ARKit
import Foundation
import SwiftUI
import CrackCore

/// 静止画の上での計測の実行と結果保持。
///
/// 流れ: 撮る（`MeasurementStill`）→ 亀裂をなぞって 1 本ずつ測る（主）／枠内を全部測る（副）
/// → 選んだものを記録する。
@MainActor
final class MeasureViewModel: ObservableObject {

    struct Candidate: Identifiable {
        let id: UUID
        let measurement: CrackMeasurement
        /// 元画像座標での芯線
        let centerlineInImage: [Vec2]
        /// 表示画像（画面の向きに回した静止画）座標での芯線
        let centerlineDisplay: [Vec2]
        /// この候補の切り出しに対応する換算器（切り出しごとに主点が違う）
        let scale: SurfaceScale
        var isSelected: Bool
    }

    @Published private(set) var still: MeasurementStill?
    @Published private(set) var candidates: [Candidate] = []
    @Published private(set) var isRunning = false
    @Published var errorMessage: String?
    /// 結果に添える注記（ライブ映像で代用した・深度を直前の推定で代用した・ブレている）
    @Published private(set) var notices: [String] = []
    /// なぞった線（表示座標）。案内として薄く描く
    @Published private(set) var strokesDisplay: [[Vec2]] = []
    /// 「全部測る」でフィルタが落とした本数
    @Published private(set) var rejectedCount = 0

    /// 「全部測る」の候補に掛けるフィルタ。なぞり計測には掛けない
    var filter = CandidateFilter.default

    private let service = CrackMeasurementService()

    var hasStill: Bool { still != nil }
    var hasResults: Bool { !candidates.isEmpty }
    var selectedCount: Int { candidates.filter(\.isSelected).count }

    /// 撮った静止画を計測の対象にする。
    func begin(still: MeasurementStill) {
        self.still = still
        candidates = []
        strokesDisplay = []
        rejectedCount = 0
        var notes: [String] = []
        if !still.isHighResolution {
            notes.append("高解像度フレームが取れず、ライブ映像で計測します（分解能が粗い）")
        }
        if still.usedFallbackEstimate {
            notes.append("このフレームに深度が無く、直前のライブ映像の壁面推定でスケールを決めました")
        }
        if !still.isSharp {
            notes.append(String(format: "ブレています（ピント指標 %.4f）。幅が太く出るので撮り直しを勧めます", still.focusScore))
        }
        notices = notes
    }

    func clear() {
        still = nil
        candidates = []
        notices = []
        strokesDisplay = []
        rejectedCount = 0
    }

    func toggle(_ id: UUID) {
        guard let index = candidates.firstIndex(where: { $0.id == id }) else { return }
        candidates[index].isSelected.toggle()
    }

    /// 表示座標の点に最も近い候補（半径以内）。線をタップして選ぶのに使う
    func nearestCandidate(toDisplayPoint point: Vec2, within radius: Double) -> UUID? {
        var best: (id: UUID, distance: Double)?
        for candidate in candidates {
            let d = candidate.centerlineDisplay.map { $0.distance(to: point) }.min() ?? .infinity
            if d <= radius, d < (best?.distance ?? .infinity) {
                best = (candidate.id, d)
            }
        }
        return best?.id
    }

    /// 目標幅がこの分解能で何 px に写るかから、縮小率・リッジスケール・背景半径を決める。
    private func tunedOptions(
        for input: CrackMeasurementService.Input,
        plane: Plane,
        targetCrackWidthMM: Double
    ) -> CrackDetector.Options {
        let scale = SurfaceScale(intrinsics: input.intrinsics, plane: plane)
        let center = Vec2(Double(input.intrinsics.imageWidth) / 2, Double(input.intrinsics.imageHeight) / 2)
        let mmPerPx = scale.nominalMillimetersPerPixel(at: center) ?? 0
        let targetPx = AnalysisPlanner.targetWidthPx(targetWidthMM: targetCrackWidthMM, millimetersPerPixel: mmPerPx)
        return AnalysisPlanner.detectorOptions(targetWidthPx: targetPx)
    }

    private func makeCandidate(
        _ measurement: CrackMeasurement,
        cropOrigin: Vec2,
        scale: SurfaceScale,
        mapping: RotatedImageMapping,
        isSelected: Bool
    ) -> Candidate {
        let inImage = measurement.centerline.map { $0 + cropOrigin }
        return Candidate(
            id: measurement.id,
            measurement: measurement,
            centerlineInImage: inImage,
            centerlineDisplay: inImage.map(mapping.toRotated),
            scale: scale,
            isSelected: isSelected
        )
    }

    /// 解析範囲（枠）の中のひび割れをすべて検出する。候補は既定で**選ばない**。
    ///
    /// 暗くて細長いものは全部候補になる（目地・斑点・影の縁）。フィルタで明らかな
    /// ゴミを落とし、残りは人が選ぶ。
    func measureAll(targetCrackWidthMM: Double) async {
        guard let still, !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        guard let input = MeasurementInputBuilder.build(
            frame: still.frame,
            normalizedRegion: still.analysisRegion,
            plane: still.estimate.plane
        ) else {
            errorMessage = "解析領域を作れませんでした"
            return
        }
        await service.updateOptions(tunedOptions(for: input, plane: still.estimate.plane, targetCrackWidthMM: targetCrackWidthMM))

        let output = await service.detectAll(input)
        let kept = filter.apply(output.measurements)
        rejectedCount = output.measurements.count - kept.count
        guard !kept.isEmpty else {
            errorMessage = String(
                format: "枠の中にひび割れらしいものが見つかりませんでした（%d 本を亀裂ではないと判断）。"
                    + "亀裂を直接なぞるか、目標幅 %.2f mm を対象の級に合わせてください",
                rejectedCount, targetCrackWidthMM
            )
            return
        }
        candidates = kept.map {
            makeCandidate($0, cropOrigin: input.cropOrigin, scale: output.scale, mapping: still.mapping, isSelected: false)
        }
    }

    /// なぞった線に沿う 1 本だけを測る。結果は候補に**追加**し、選択済みにする。
    ///
    /// - Parameters:
    ///   - displayStroke: 表示画像座標の点列
    ///   - searchRadiusPx: 線からこの距離（px）以内の芯線を対象にする。画面上の指の大きさから換算
    func measureAlong(displayStroke: [Vec2], searchRadiusPx: Double, targetCrackWidthMM: Double) async {
        guard let still, !isRunning, displayStroke.count >= 2 else { return }
        isRunning = true
        defer { isRunning = false }

        let rawStroke = displayStroke.map(still.mapping.toRaw)
        guard let minX = rawStroke.map(\.x).min(), let maxX = rawStroke.map(\.x).max(),
              let minY = rawStroke.map(\.y).min(), let maxY = rawStroke.map(\.y).max() else { return }
        // 切り出しはなぞった線の外接矩形 + 余白（探索半径 + 断面の探索半径ぶん）
        let margin = Int(searchRadiusPx) + 240
        let rect = PixelRect(
            x: Int(minX) - margin,
            y: Int(minY) - margin,
            width: Int(maxX - minX) + margin * 2,
            height: Int(maxY - minY) + margin * 2
        )
        guard let input = MeasurementInputBuilder.build(frame: still.frame, pixelRect: rect, plane: still.estimate.plane) else {
            errorMessage = "解析領域を作れませんでした"
            return
        }
        await service.updateOptions(tunedOptions(for: input, plane: still.estimate.plane, targetCrackWidthMM: targetCrackWidthMM))

        guard let measurement = await service.measureAlong(input, stroke: rawStroke, searchRadiusPx: Int(searchRadiusPx)) else {
            errorMessage = String(
                format: "なぞった線の近くにひび割れが見つかりませんでした。ピンチで拡大して亀裂の上を正確になぞってください。"
                    + "対象が目標幅 %.2f mm の 0.8〜4 倍から外れているなら、案件の目標幅を変えてください",
                targetCrackWidthMM
            )
            return
        }
        let scale = SurfaceScale(intrinsics: input.intrinsics, plane: still.estimate.plane)
        strokesDisplay.append(displayStroke)
        candidates.append(
            makeCandidate(measurement, cropOrigin: input.cropOrigin, scale: scale, mapping: still.mapping, isSelected: true)
        )
    }

    /// 選択されたひび割れを記録に変換する。
    func makeRecords(startingLabelNumber: Int, photoRelativePath: String?) -> [CrackRecord] {
        var number = startingLabelNumber
        var records: [CrackRecord] = []
        for candidate in candidates where candidate.isSelected {
            records.append(
                CrackRecord(
                    label: String(format: "C-%03d", number),
                    measurement: candidate.measurement,
                    scale: candidate.scale,
                    photoRelativePath: photoRelativePath
                )
            )
            number += 1
        }
        return records
    }
}
