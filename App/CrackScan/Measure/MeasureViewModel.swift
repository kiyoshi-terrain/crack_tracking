import ARKit
import Foundation
import SwiftUI
import CrackCore

/// 撮影画面から呼ばれる計測の実行と結果保持。
@MainActor
final class MeasureViewModel: ObservableObject {

    struct Candidate: Identifiable {
        let id: UUID
        let measurement: CrackMeasurement
        /// 元画像座標での芯線
        let centerlineInImage: [Vec2]
        var isSelected: Bool
    }

    @Published private(set) var candidates: [Candidate] = []
    @Published private(set) var isRunning = false
    @Published private(set) var sourceImageSize: CGSize = .zero
    @Published var errorMessage: String?
    /// 結果に添える注記（ライブ映像で代用した、深度を直前の推定で代用した、など）。
    /// エラーではないのでアラートにはしない
    @Published var notice: String?

    /// 計測に使ったフレーム（オーバーレイの座標変換に必要）
    private(set) var referenceFrame: ARFrame?
    private(set) var scale: SurfaceScale?
    private(set) var savedPhotoURL: URL?
    /// 検出に使った縮小率（表示・記録用）
    private(set) var detectionFactor: Int = 1

    private let service = CrackMeasurementService()

    var hasResults: Bool { !candidates.isEmpty }
    var selectedCount: Int { candidates.filter(\.isSelected).count }

    func clear() {
        candidates = []
        referenceFrame = nil
        scale = nil
        savedPhotoURL = nil
        notice = nil
        detectionFactor = 1
    }

    func toggle(_ id: UUID) {
        guard let index = candidates.firstIndex(where: { $0.id == id }) else { return }
        candidates[index].isSelected.toggle()
    }

    /// 解析入力の組み立てと、目標幅に合わせた検出パラメータの設定。
    ///
    /// - Parameter fallbackEstimate: フレーム自身の深度から平面が取れないときに使う直前のライブ推定
    private func prepare(
        frame: ARFrame,
        normalizedRegion: CGRect,
        targetCrackWidthMM: Double,
        fallbackEstimate: DepthPlaneEstimator.Estimate?
    ) async -> (input: CrackMeasurementService.Input, estimate: DepthPlaneEstimator.Estimate)? {
        var usedFallback = false
        var estimate = DepthPlaneEstimator.estimate(frame: frame, normalizedRegion: normalizedRegion)
        if estimate == nil, let fallbackEstimate {
            estimate = fallbackEstimate
            usedFallback = true
        }
        guard let estimate else {
            errorMessage = "壁面までの距離を取得できませんでした。LiDAR の届く距離（〜3m）まで近づいて、少し待ってからもう一度押してください"
            return nil
        }
        guard let input = MeasurementInputBuilder.build(
            frame: frame,
            normalizedRegion: normalizedRegion,
            plane: estimate.plane
        ) else {
            errorMessage = "解析領域を作れませんでした"
            return nil
        }

        // 目標幅がこの分解能で何 px に写るかから、縮小率・リッジスケール・背景半径を決める。
        // 幅広の開口を等倍で追うとカーネルが巨大になって数十秒かかるので、検出は縮小画像で。
        let scaleForHint = SurfaceScale(intrinsics: input.intrinsics, plane: estimate.plane)
        let center = Vec2(Double(input.intrinsics.imageWidth) / 2, Double(input.intrinsics.imageHeight) / 2)
        let mmPerPx = scaleForHint.nominalMillimetersPerPixel(at: center) ?? 0
        let targetPx = AnalysisPlanner.targetWidthPx(targetWidthMM: targetCrackWidthMM, millimetersPerPixel: mmPerPx)
        let options = AnalysisPlanner.detectorOptions(targetWidthPx: targetPx)
        detectionFactor = options.downsampleFactor
        await service.updateOptions(options)

        if usedFallback {
            notice = "このフレームに深度が無かったので、直前のライブ映像の壁面推定でスケールを決めました"
        }
        return (input, estimate)
    }

    /// 現在のフレームから、解析範囲内のひび割れをすべて計測する。
    func measure(
        frame: ARFrame,
        normalizedRegion: CGRect,
        targetCrackWidthMM: Double,
        fallbackEstimate: DepthPlaneEstimator.Estimate? = nil
    ) async {
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        guard let prepared = await prepare(
            frame: frame,
            normalizedRegion: normalizedRegion,
            targetCrackWidthMM: targetCrackWidthMM,
            fallbackEstimate: fallbackEstimate
        ) else { return }
        let input = prepared.input

        let output = await service.detectAll(input)
        guard !output.measurements.isEmpty else {
            errorMessage = String(
                format: "ひび割れを検出できませんでした。枠を対象に合わせ、ピントを確認してください。"
                    + "目標幅 %.2f mm の 0.8〜4 倍の幅を狙って検出しています。対象がもっと太い／細いなら案件の目標幅を変えてください",
                targetCrackWidthMM
            )
            return
        }

        referenceFrame = frame
        scale = output.scale
        sourceImageSize = frame.capturedImageSize
        candidates = zip(output.measurements, output.centerlinesInSourceImage).map { measurement, line in
            Candidate(
                id: measurement.id,
                measurement: measurement,
                centerlineInImage: line,
                // 目標幅以上のものを既定で選択しておく
                isSelected: measurement.maxWidthMM >= targetCrackWidthMM
            )
        }
    }

    /// 画面タップ位置の1本だけを計測する。
    ///
    /// - Parameter searchRadiusPx: タップ位置から芯線を探す半径（元画像の px）。
    ///   画面上の指の大きさを画像 px に換算して渡す
    func measureOne(
        frame: ARFrame,
        normalizedRegion: CGRect,
        imagePoint: Vec2,
        searchRadiusPx: Int,
        targetCrackWidthMM: Double,
        fallbackEstimate: DepthPlaneEstimator.Estimate? = nil
    ) async {
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        guard let prepared = await prepare(
            frame: frame,
            normalizedRegion: normalizedRegion,
            targetCrackWidthMM: targetCrackWidthMM,
            fallbackEstimate: fallbackEstimate
        ) else { return }
        let input = prepared.input
        let estimate = prepared.estimate

        guard let measurement = await service.measureOne(input, at: imagePoint, searchRadiusPx: searchRadiusPx) else {
            errorMessage = "その位置にひび割れが見つかりませんでした。枠の中の亀裂の上をタップしてください"
            return
        }

        referenceFrame = frame
        scale = SurfaceScale(intrinsics: input.intrinsics, plane: estimate.plane)
        sourceImageSize = frame.capturedImageSize
        candidates = [
            Candidate(
                id: measurement.id,
                measurement: measurement,
                centerlineInImage: measurement.centerline.map { $0 + input.cropOrigin },
                isSelected: true
            ),
        ]
    }

    /// 選択されたひび割れを記録に変換する。
    func makeRecords(startingLabelNumber: Int, photoRelativePath: String?) -> [CrackRecord] {
        guard let scale else { return [] }
        var number = startingLabelNumber
        var records: [CrackRecord] = []
        for candidate in candidates where candidate.isSelected {
            records.append(
                CrackRecord(
                    label: String(format: "C-%03d", number),
                    measurement: candidate.measurement,
                    scale: scale,
                    photoRelativePath: photoRelativePath
                )
            )
            number += 1
        }
        return records
    }
}
