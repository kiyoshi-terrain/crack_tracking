import ARKit
import Foundation
import CrackCore

/// ARFrame からひび割れを検出・計測するサービス。
///
/// 重い処理なのでバックグラウンドで走らせ、UI からは async で呼びます。
actor CrackMeasurementService {

    struct Input: Sendable {
        /// 解析対象の輝度画像（線形光・原寸）
        let image: GrayImage
        /// `image` に対応する内部パラメータ
        let intrinsics: CameraIntrinsics
        let plane: Plane
        /// 元画像に対する切り出しオフセット（結果を元画像座標に戻すのに使う）
        let cropOrigin: Vec2
    }

    struct Output: Sendable {
        let measurements: [CrackMeasurement]
        let scale: SurfaceScale
        /// 検出に使った縮小率
        let detectionFactor: Int
    }

    private var detector: CrackDetector

    init(options: CrackDetector.Options = .default) {
        self.detector = CrackDetector(options: options)
    }

    func updateOptions(_ options: CrackDetector.Options) {
        detector = CrackDetector(options: options)
    }

    /// 領域内のひび割れをすべて検出する。芯線は切り出し座標。
    func detectAll(_ input: Input) -> Output {
        let scale = SurfaceScale(intrinsics: input.intrinsics, plane: input.plane)
        let result = detector.detect(in: input.image, scale: scale)
        return Output(
            measurements: result.measurements,
            scale: scale,
            detectionFactor: result.detectionFactor
        )
    }

    /// なぞった線に沿う 1 本だけを測る。
    ///
    /// - Parameters:
    ///   - stroke: 元画像 px の点列
    ///   - searchRadiusPx: 元画像 px での探索半径
    func measureAlong(_ input: Input, stroke: [Vec2], searchRadiusPx: Int) -> CrackMeasurement? {
        let scale = SurfaceScale(intrinsics: input.intrinsics, plane: input.plane)
        return detector.measureAlong(
            in: input.image,
            stroke: stroke.map { $0 - input.cropOrigin },
            scale: scale,
            searchRadiusPx: searchRadiusPx
        )
    }
}

/// ARFrame から解析入力を組み立てる。
enum MeasurementInputBuilder {

    /// 安全弁としての一辺の上限（px）。
    ///
    /// 解析範囲の大きさは `ARCaptureController.analysisRegion(for:)` が縮小率に応じて決め、
    /// 画面の枠として描いている。ここで黙って切ると描いた枠と食い違うので、
    /// 通常はここに掛からない。ビューポートが未確定のまま呼ばれたときの保険。
    static let hardLimitSide = 4200

    /// 正規化矩形で指定した範囲を切り出す。
    static func build(
        frame: ARFrame,
        normalizedRegion: CGRect,
        plane: Plane
    ) -> CrackMeasurementService.Input? {
        let intrinsics = DepthPlaneEstimator.cameraIntrinsics(frame: frame)
        let rect = PixelRect(
            x: Int(normalizedRegion.minX * CGFloat(intrinsics.imageWidth)),
            y: Int(normalizedRegion.minY * CGFloat(intrinsics.imageHeight)),
            width: Int(normalizedRegion.width * CGFloat(intrinsics.imageWidth)),
            height: Int(normalizedRegion.height * CGFloat(intrinsics.imageHeight))
        )
        return build(frame: frame, pixelRect: rect, plane: plane)
    }

    /// 画素矩形で指定した範囲を切り出す（画像の外ははみ出しをクランプ）。
    static func build(
        frame: ARFrame,
        pixelRect: PixelRect,
        plane: Plane
    ) -> CrackMeasurementService.Input? {
        let intrinsics = DepthPlaneEstimator.cameraIntrinsics(frame: frame)

        var rect = pixelRect.clamped(toWidth: intrinsics.imageWidth, height: intrinsics.imageHeight)
        rect = AnalysisPlanner.clampRegion(rect, maxSide: hardLimitSide)

        guard rect.width > 32, rect.height > 32,
              let image = ImageConversion.grayImage(
                  from: frame.capturedImage,
                  region: rect,
                  linearize: true
              ) else { return nil }

        // 切り出した画像に合わせて主点をずらす（焦点距離は変わらない）
        var croppedIntrinsics = intrinsics
        croppedIntrinsics.cx -= Double(rect.x)
        croppedIntrinsics.cy -= Double(rect.y)
        croppedIntrinsics.imageWidth = rect.width
        croppedIntrinsics.imageHeight = rect.height

        return CrackMeasurementService.Input(
            image: image,
            intrinsics: croppedIntrinsics,
            plane: plane,
            cropOrigin: Vec2(Double(rect.x), Double(rect.y))
        )
    }
}
