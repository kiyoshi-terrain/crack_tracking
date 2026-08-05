import ARKit
import Foundation
import CrackCore

/// ARFrame からひび割れを検出・計測するサービス。
///
/// 重い処理なのでバックグラウンドで走らせ、UI からは async で呼びます。
actor CrackMeasurementService {

    struct Input: Sendable {
        /// 解析対象の輝度画像（線形光）
        let image: GrayImage
        /// `image` に対応する内部パラメータ
        let intrinsics: CameraIntrinsics
        let plane: Plane
        /// 元画像に対する切り出しオフセット（結果を画面座標に戻すのに使う）
        let cropOrigin: Vec2
    }

    struct Output: Sendable {
        let measurements: [CrackMeasurement]
        let scale: SurfaceScale
        /// 元画像座標に戻した芯線
        let centerlinesInSourceImage: [[Vec2]]
    }

    private var detector: CrackDetector

    init(options: CrackDetector.Options = .default) {
        self.detector = CrackDetector(options: options)
    }

    func updateOptions(_ options: CrackDetector.Options) {
        detector = CrackDetector(options: options)
    }

    /// 領域内のひび割れをすべて検出する。
    func detectAll(_ input: Input) -> Output {
        let scale = SurfaceScale(intrinsics: input.intrinsics, plane: input.plane)
        let result = detector.detect(in: input.image, scale: scale)
        return Output(
            measurements: result.measurements,
            scale: scale,
            centerlinesInSourceImage: result.measurements.map { m in
                m.centerline.map { $0 + input.cropOrigin }
            }
        )
    }

    /// 指定点の1本だけを計測する。
    func measureOne(_ input: Input, at point: Vec2) -> CrackMeasurement? {
        let scale = SurfaceScale(intrinsics: input.intrinsics, plane: input.plane)
        return detector.measureCrack(in: input.image, near: point - input.cropOrigin, scale: scale)
    }
}

/// ARFrame から解析入力を組み立てる。
enum MeasurementInputBuilder {

    /// 解析に使う最大の一辺（px）。
    /// 48MP 全面をそのまま処理すると数十秒かかるため、
    /// レティクル内だけを等倍で切り出して精度を保ちつつ処理量を抑える。
    static let maxAnalysisSide = 1600

    /// レティクル領域を切り出して解析入力を作る。
    static func build(
        frame: ARFrame,
        normalizedRegion: CGRect,
        plane: Plane
    ) -> CrackMeasurementService.Input? {
        let intrinsics = DepthPlaneEstimator.cameraIntrinsics(frame: frame)

        var rect = PixelRect(
            x: Int(normalizedRegion.minX * CGFloat(intrinsics.imageWidth)),
            y: Int(normalizedRegion.minY * CGFloat(intrinsics.imageHeight)),
            width: Int(normalizedRegion.width * CGFloat(intrinsics.imageWidth)),
            height: Int(normalizedRegion.height * CGFloat(intrinsics.imageHeight))
        ).clamped(toWidth: intrinsics.imageWidth, height: intrinsics.imageHeight)

        // 大きすぎる場合は中央を残して縮める（縮小ではなくトリミング。
        // 縮小すると細いひび割れが消えてしまうため）
        if rect.width > maxAnalysisSide {
            rect.x += (rect.width - maxAnalysisSide) / 2
            rect.width = maxAnalysisSide
        }
        if rect.height > maxAnalysisSide {
            rect.y += (rect.height - maxAnalysisSide) / 2
            rect.height = maxAnalysisSide
        }

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
