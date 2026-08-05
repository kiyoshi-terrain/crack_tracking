import ARKit
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import CrackCore

/// 撮影1枚分を「画像 + デプス + メタデータ」の組で保存する。
///
/// 保存形式は Apple の Object Capture がそのまま読める配置に揃えてあります。
/// - `Images/frame_0000.heic` … カラー画像
/// - `Depth/frame_0000.tif`  … Float32 デプス（PhotogrammetrySample の depthDataMap 相当）
/// - `Meta/frame_0000.json`  … 内部パラメータ・姿勢・平面・撮影条件
///
/// メタデータを別に持っておくと、社内の SfM や外部の写真測量ソフトへ
/// 持ち出すときにスケール基準を引き継げます。
struct FrameBundleWriter {

    struct Bundle {
        let imageURL: URL
        let depthURL: URL?
        let metadataURL: URL
    }

    enum WriterError: LocalizedError {
        case imageEncodingFailed
        case directoryCreationFailed(String)

        var errorDescription: String? {
            switch self {
            case .imageEncodingFailed: return "画像のエンコードに失敗しました"
            case .directoryCreationFailed(let path): return "フォルダを作成できません: \(path)"
            }
        }
    }

    private let context = CIContext(options: [.useSoftwareRenderer: false])

    /// 圧縮品質の指定キー。CFString をそのままキャストできないので rawValue 経由で作る。
    private static let compressionQualityKey = CIImageRepresentationOption(
        rawValue: kCGImageDestinationLossyCompressionQuality as String
    )

    func write(frame: ARFrame, index: Int, into directory: URL) throws -> Bundle {
        let images = directory.appendingPathComponent("Images", isDirectory: true)
        let depths = directory.appendingPathComponent("Depth", isDirectory: true)
        let metas = directory.appendingPathComponent("Meta", isDirectory: true)
        for url in [images, depths, metas] {
            do {
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            } catch {
                throw WriterError.directoryCreationFailed(url.path)
            }
        }

        let name = String(format: "frame_%04d", index)

        // カラー画像（HEIC）。ひび割れは細い暗線なので圧縮は控えめにする。
        var imageURL = images.appendingPathComponent("\(name).heic")
        let ciImage = CIImage(cvPixelBuffer: frame.capturedImage)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else {
            throw WriterError.imageEncodingFailed
        }
        do {
            try context.writeHEIFRepresentation(
                of: ciImage,
                to: imageURL,
                format: .RGBA8,
                colorSpace: colorSpace,
                options: [Self.compressionQualityKey: 0.95]
            )
        } catch {
            // HEIF 非対応時は JPEG にフォールバック
            imageURL = images.appendingPathComponent("\(name).jpg")
            try context.writeJPEGRepresentation(
                of: ciImage,
                to: imageURL,
                colorSpace: colorSpace,
                options: [Self.compressionQualityKey: 0.95]
            )
        }

        // デプス（Float32 TIFF）
        var depthURL: URL?
        if let sceneDepth = frame.smoothedSceneDepth ?? frame.sceneDepth {
            let url = depths.appendingPathComponent("\(name).tif")
            if writeDepthTIFF(sceneDepth.depthMap, to: url) {
                depthURL = url
            }
        }

        // メタデータ
        let metadataURL = metas.appendingPathComponent("\(name).json")
        let metadata = FrameMetadata(frame: frame, index: index)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(metadata).write(to: metadataURL, options: .atomic)

        return Bundle(imageURL: imageURL, depthURL: depthURL, metadataURL: metadataURL)
    }

    /// Float32 の単チャンネル TIFF としてデプスを書き出す。
    private func writeDepthTIFF(_ depthMap: CVPixelBuffer, to url: URL) -> Bool {
        let ciImage = CIImage(cvPixelBuffer: depthMap)
        guard let colorSpace = CGColorSpace(name: CGColorSpace.linearGray) else { return false }
        do {
            try context.writeTIFFRepresentation(
                of: ciImage,
                to: url,
                format: .Lf,
                colorSpace: colorSpace,
                options: [:]
            )
            return true
        } catch {
            return false
        }
    }
}

/// 1フレームのメタデータ。写真測量の外部処理に渡せるよう素の数値で保存する。
struct FrameMetadata: Codable {
    let index: Int
    let timestamp: TimeInterval
    let imageWidth: Int
    let imageHeight: Int
    /// [fx, fy, cx, cy]
    let intrinsics: [Double]
    /// ARKit の camera.transform を行優先で並べた16要素（ワールド→カメラの逆）
    let cameraTransform: [Double]
    /// 推定した壁面（カメラ座標系）: [nx, ny, nz, d]
    let wallPlane: [Double]?
    let exposureDuration: Double
    let exposureOffset: Double

    init(frame: ARFrame, index: Int, wallPlane: Plane? = nil) {
        self.index = index
        self.timestamp = frame.timestamp
        let resolution = frame.camera.imageResolution
        self.imageWidth = Int(resolution.width)
        self.imageHeight = Int(resolution.height)

        let m = frame.camera.intrinsics
        self.intrinsics = [Double(m[0][0]), Double(m[1][1]), Double(m[2][0]), Double(m[2][1])]

        let t = frame.camera.transform
        self.cameraTransform = (0..<4).flatMap { col in
            (0..<4).map { row in Double(t[col][row]) }
        }

        self.wallPlane = wallPlane.map { [$0.normal.x, $0.normal.y, $0.normal.z, $0.distance] }
        self.exposureDuration = frame.camera.exposureDuration
        self.exposureOffset = Double(frame.camera.exposureOffset)
    }
}
