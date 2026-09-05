import ARKit
import CoreGraphics
import Foundation
import CrackCore

/// 計測のために撮った 1 枚。計測はこの静止画の上で行う。
///
/// ライブ映像の上に結果を重ねると、手が動くたびに線がずれて何を測ったのか
/// 確かめられない。撮った瞬間の画像・壁面・ブレを固定し、その上でなぞって測る。
struct MeasurementStill {
    let frame: ARFrame
    /// false ならライブ映像（1920px 級）で代用した
    let isHighResolution: Bool
    /// 壁面（カメラ座標系）
    let estimate: DepthPlaneEstimator.Estimate
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
    /// 解析範囲の中心での代表値
    let millimetersPerPixel: Double
    let distance: Double
    let capturedAt: Date

    /// 元画像の画素数
    var rawImageSize: CGSize { frame.capturedImageSize }

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
