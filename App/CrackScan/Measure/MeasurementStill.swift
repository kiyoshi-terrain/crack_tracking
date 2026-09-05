import ARKit
import CoreGraphics
import Foundation
import CrackCore

/// 既知の長さで合わせた縦尺（スケールバー校正）の状態。
struct ScaleCorrectionState {
    /// LiDAR の縦尺に対する累積の倍率
    var factor: Double
    /// 入力した既知の長さ（mm）
    var knownMM: Double
    /// LiDAR の縦尺で測れていた長さ（mm）
    var measuredMM: Double
    /// 目印の 2 点（表示座標）
    var marksDisplay: [Vec2]
}

/// 計測のために撮った 1 枚。計測はこの静止画の上で行う。
///
/// ライブ映像の上に結果を重ねると、手が動くたびに線がずれて何を測ったのか
/// 確かめられない。撮った瞬間の画像・壁面・ブレを固定し、その上でなぞって測る。
struct MeasurementStill {
    let frame: ARFrame
    /// false ならライブ映像（1920px 級）で代用した
    let isHighResolution: Bool
    /// 壁面（カメラ座標系）。縦尺補正を当てると法線方向に動く
    var estimate: DepthPlaneEstimator.Estimate
    /// LiDAR から得た元の壁面（補正を外すときに戻す）
    let originalEstimate: DepthPlaneEstimator.Estimate
    /// このフレームに深度が無く、直前のライブ推定で代用したか
    let usedFallbackEstimate: Bool
    /// 解析範囲（**元画像**の正規化座標）
    let analysisRegion: CGRect
    /// 表示用に画面の向きへ回した画像
    let display: CGImage
    /// 表示画像の座標 ↔ 元画像の座標
    let mapping: RotatedImageMapping
    /// ブレ指標（ライブ判定と同じ尺度に縮小して計算）と、しきい値を満たすか
    let focusScore: Double
    let isSharp: Bool
    /// 解析範囲の中心での代表値（縦尺補正で変わる）
    var millimetersPerPixel: Double
    var distance: Double
    let capturedAt: Date
    /// 既知の長さで合わせた縦尺。nil なら LiDAR のまま
    var scaleCorrection: ScaleCorrectionState?

    init(
        frame: ARFrame,
        isHighResolution: Bool,
        estimate: DepthPlaneEstimator.Estimate,
        usedFallbackEstimate: Bool,
        analysisRegion: CGRect,
        display: CGImage,
        mapping: RotatedImageMapping,
        focusScore: Double,
        isSharp: Bool,
        millimetersPerPixel: Double,
        distance: Double,
        capturedAt: Date
    ) {
        self.frame = frame
        self.isHighResolution = isHighResolution
        self.estimate = estimate
        self.originalEstimate = estimate
        self.usedFallbackEstimate = usedFallbackEstimate
        self.analysisRegion = analysisRegion
        self.display = display
        self.mapping = mapping
        self.focusScore = focusScore
        self.isSharp = isSharp
        self.millimetersPerPixel = millimetersPerPixel
        self.distance = distance
        self.capturedAt = capturedAt
        self.scaleCorrection = nil
    }

    /// 元画像の画素数
    var rawImageSize: CGSize { frame.capturedImageSize }

    /// 元画像全体の換算器（現在の縦尺）
    var fullScale: SurfaceScale {
        SurfaceScale(intrinsics: DepthPlaneEstimator.cameraIntrinsics(frame: frame), plane: estimate.plane)
    }

    /// 表示座標の 2 点のあいだの、壁面上の距離（mm）。現在の縦尺で
    func surfaceDistanceMM(displayA: Vec2, displayB: Vec2) -> Double? {
        fullScale.surfaceDistance(from: mapping.toRaw(displayA), to: mapping.toRaw(displayB)).map { $0 * 1000 }
    }

    /// 解析範囲を表示画像の座標で（枠として描く）
    var analysisRegionDisplay: CGRect {
        let w = rawImageSize.width, h = rawImageSize.height
        let corners = [
            Vec2(analysisRegion.minX * w, analysisRegion.minY * h),
            Vec2(analysisRegion.maxX * w, analysisRegion.minY * h),
            Vec2(analysisRegion.minX * w, analysisRegion.maxY * h),
            Vec2(analysisRegion.maxX * w, analysisRegion.maxY * h),
        ].map(mapping.toRotated)
        let xs = corners.map(\.x), ys = corners.map(\.y)
        guard let x0 = xs.min(), let x1 = xs.max(), let y0 = ys.min(), let y1 = ys.max() else { return .zero }
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }
}
