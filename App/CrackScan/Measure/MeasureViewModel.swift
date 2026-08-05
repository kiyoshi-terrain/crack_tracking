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

    /// 計測に使ったフレーム（オーバーレイの座標変換に必要）
    private(set) var referenceFrame: ARFrame?
    private(set) var scale: SurfaceScale?
    private(set) var savedPhotoURL: URL?

    private let service = CrackMeasurementService()

    var hasResults: Bool { !candidates.isEmpty }
    var selectedCount: Int { candidates.filter(\.isSelected).count }

    func clear() {
        candidates = []
        referenceFrame = nil
        scale = nil
        savedPhotoURL = nil
    }

    func toggle(_ id: UUID) {
        guard let index = candidates.firstIndex(where: { $0.id == id }) else { return }
        candidates[index].isSelected.toggle()
    }

    /// 現在のフレームから、レティクル内のひび割れをすべて計測する。
    func measure(
        frame: ARFrame,
        normalizedRegion: CGRect,
        targetCrackWidthMM: Double
    ) async {
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        guard let estimate = DepthPlaneEstimator.estimate(frame: frame, normalizedRegion: normalizedRegion) else {
            errorMessage = "壁面までの距離を取得できませんでした。LiDAR の届く距離（〜5m）まで近づいてください"
            return
        }
        guard let input = MeasurementInputBuilder.build(
            frame: frame,
            normalizedRegion: normalizedRegion,
            plane: estimate.plane
        ) else {
            errorMessage = "解析領域を作れませんでした"
            return
        }

        // 目標幅に合わせて検出スケールを調整する。
        // 細いひび割れを狙うときは小さい σ を厚めに、太いときは大きい σ を含める。
        var options = CrackDetector.Options.default
        let scaleForHint = SurfaceScale(intrinsics: input.intrinsics, plane: estimate.plane)
        let center = Vec2(Double(input.intrinsics.imageWidth) / 2, Double(input.intrinsics.imageHeight) / 2)
        if let mmPerPx = scaleForHint.nominalMillimetersPerPixel(at: center), mmPerPx > 0 {
            let targetPx = targetCrackWidthMM / mmPerPx
            options.ridgeScales = [
                max(0.8, targetPx * 0.4),
                max(1.0, targetPx * 0.7),
                max(1.4, targetPx * 1.2),
                max(2.0, targetPx * 2.0),
            ]
            options.backgroundRadiusPx = max(12, Int(targetPx * 8))
        }
        await service.updateOptions(options)

        let output = await service.detectAll(input)
        guard !output.measurements.isEmpty else {
            errorMessage = "ひび割れを検出できませんでした。枠を対象に合わせ、近づいてピントを合わせてください"
            return
        }

        referenceFrame = frame
        scale = output.scale
        sourceImageSize = frame.camera.imageResolution
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
    func measureOne(
        frame: ARFrame,
        normalizedRegion: CGRect,
        imagePoint: Vec2
    ) async {
        guard !isRunning else { return }
        isRunning = true
        defer { isRunning = false }

        guard let estimate = DepthPlaneEstimator.estimate(frame: frame, normalizedRegion: normalizedRegion),
              let input = MeasurementInputBuilder.build(
                  frame: frame,
                  normalizedRegion: normalizedRegion,
                  plane: estimate.plane
              ) else {
            errorMessage = "計測できませんでした"
            return
        }

        guard let measurement = await service.measureOne(input, at: imagePoint) else {
            errorMessage = "その位置にひび割れが見つかりませんでした。枠の中をタップしてください"
            return
        }

        referenceFrame = frame
        scale = SurfaceScale(intrinsics: input.intrinsics, plane: estimate.plane)
        sourceImageSize = frame.camera.imageResolution
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
