import CoreVideo
import Foundation
import CrackCore

/// CVPixelBuffer / CGImage と `GrayImage` の相互変換。
public enum ImageConversion {

    /// sRGB の逆ガンマ（8bit → 線形光）のルックアップテーブル。
    ///
    /// 幅計測を**線形光**で行うのは重要です。ある画素の半分がひび割れに
    /// 覆われているとき、線形光では値がちょうど背景と亀裂の中間になります。
    /// つまり半値幅の交差点がそのまま幾何的なエッジ位置になる。
    /// ガンマ符号化されたままだと、この対応が崩れて幅が系統的にずれます。
    static let srgbToLinear: [Float] = (0..<256).map { i in
        let c = Double(i) / 255.0
        let linear = c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        return Float(linear)
    }

    /// ARKit のキャプチャ画像（YCbCr 420 バイプラナ）の Y プレーンから輝度画像を作る。
    ///
    /// - Parameters:
    ///   - pixelBuffer: `ARFrame.capturedImage`
    ///   - linearize: 線形光に戻すか（幅計測では true 推奨）
    ///   - downsample: 整数の縮小率
    public static func grayImage(
        from pixelBuffer: CVPixelBuffer,
        linearize: Bool = true,
        downsample: Int = 1
    ) -> GrayImage? {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let format = CVPixelBufferGetPixelFormatType(pixelBuffer)
        let isBiPlanar = format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            || format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

        guard isBiPlanar,
              let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return nil }

        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let isVideoRange = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

        let step = max(1, downsample)
        let outWidth = width / step
        let outHeight = height / step
        guard outWidth > 0, outHeight > 0 else { return nil }

        var out = GrayImage(width: outWidth, height: outHeight)
        let pointer = base.assumingMemoryBound(to: UInt8.self)

        for y in 0..<outHeight {
            for x in 0..<outWidth {
                var sum: Float = 0
                for dy in 0..<step {
                    let row = pointer + (y * step + dy) * bytesPerRow
                    for dx in 0..<step {
                        var raw = Int(row[x * step + dx])
                        if isVideoRange {
                            // 16...235 を 0...255 に伸長
                            raw = min(255, max(0, (raw - 16) * 255 / 219))
                        }
                        sum += linearize ? srgbToLinear[raw] : Float(raw) / 255
                    }
                }
                out[x, y] = sum / Float(step * step)
            }
        }
        return out
    }

    /// 部分領域だけを取り出す（全画面を変換すると 48MP では重すぎるため）。
    public static func grayImage(
        from pixelBuffer: CVPixelBuffer,
        region: PixelRect,
        linearize: Bool = true
    ) -> GrayImage? {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let format = CVPixelBufferGetPixelFormatType(pixelBuffer)
        guard format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            || format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
              let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { return nil }

        let width = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
        let height = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
        let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let isVideoRange = format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

        let rect = region.clamped(toWidth: width, height: height)
        guard rect.width > 0, rect.height > 0 else { return nil }

        var out = GrayImage(width: rect.width, height: rect.height)
        let pointer = base.assumingMemoryBound(to: UInt8.self)

        for y in 0..<rect.height {
            let row = pointer + (rect.y + y) * bytesPerRow
            for x in 0..<rect.width {
                var raw = Int(row[rect.x + x])
                if isVideoRange {
                    raw = min(255, max(0, (raw - 16) * 255 / 219))
                }
                out[x, y] = linearize ? srgbToLinear[raw] : Float(raw) / 255
            }
        }
        return out
    }

    /// 露出評価用: 飽和している画素の割合。
    public static func saturatedRatio(_ image: GrayImage, threshold: Float = 0.98) -> Double {
        guard !image.pixels.isEmpty else { return 0 }
        let count = image.pixels.reduce(0) { $0 + ($1 >= threshold ? 1 : 0) }
        return Double(count) / Double(image.pixels.count)
    }

    /// デプスマップ（Float32）から値を読む。
    /// デプスマップはキャプチャ画像より低解像度なので、正規化座標で対応付ける。
    public static func depth(
        in depthMap: CVPixelBuffer,
        atNormalized point: CGPoint
    ) -> Float? {
        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(depthMap, .readOnly) }

        let width = CVPixelBufferGetWidth(depthMap)
        let height = CVPixelBufferGetHeight(depthMap)
        let x = Int((point.x * CGFloat(width - 1)).rounded())
        let y = Int((point.y * CGFloat(height - 1)).rounded())
        guard x >= 0, y >= 0, x < width, y < height,
              let base = CVPixelBufferGetBaseAddress(depthMap) else { return nil }

        let bytesPerRow = CVPixelBufferGetBytesPerRow(depthMap)
        let row = base.advanced(by: y * bytesPerRow).assumingMemoryBound(to: Float32.self)
        let value = row[x]
        return value.isFinite && value > 0 ? value : nil
    }
}
