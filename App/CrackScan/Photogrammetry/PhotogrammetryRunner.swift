import Foundation
import RealityKit

/// 撮影した画像群から 3D モデル（USDZ）を生成する。
///
/// **役割の分担についての注意**
/// ひび割れ幅の計測値は写真測量モデルからではなく、画像 + LiDAR 平面から
/// 直接求めています（`CrackMeasurementService`）。写真測量メッシュの
/// 頂点間隔はミリ幅の計測には粗すぎるためです。
/// ここで作る 3D モデルは「どの部位のどこにあったか」を残す**記録用**であり、
/// 帳票の位置図や次回点検との比較に使います。
@available(iOS 17.0, *)
actor PhotogrammetryRunner {

    enum RunnerError: LocalizedError {
        case unsupportedDevice
        case noImages
        case sessionFailed(String)

        var errorDescription: String? {
            switch self {
            case .unsupportedDevice:
                return "この端末では 3D モデル生成に対応していません（Object Capture 非対応）"
            case .noImages:
                return "画像がありません"
            case .sessionFailed(let reason):
                return "3D モデル生成に失敗しました: \(reason)"
            }
        }
    }

    static var isSupported: Bool {
        PhotogrammetrySession.isSupported
    }

    /// 進捗（0...1）を流しながらモデルを生成する。
    ///
    /// `onProgress` はこのアクター上から呼ばれます。UI を更新する場合は
    /// 呼び出し側で MainActor へホップしてください。
    func generateModel(
        imagesDirectory: URL,
        outputURL: URL,
        onProgress: @escaping (Double) -> Void
    ) async throws {
        guard PhotogrammetrySession.isSupported else { throw RunnerError.unsupportedDevice }

        let contents = (try? FileManager.default.contentsOfDirectory(
            at: imagesDirectory,
            includingPropertiesForKeys: nil
        )) ?? []
        guard !contents.isEmpty else { throw RunnerError.noImages }

        var configuration = PhotogrammetrySession.Configuration()
        configuration.isObjectMaskingEnabled = false
        // 壁面は平板なので、対象を回り込んで撮ることを前提としない
        configuration.sampleOrdering = .sequential

        let session = try PhotogrammetrySession(input: imagesDirectory, configuration: configuration)
        // 精細度は `.reduced` 固定。iOS の Object Capture では他の値
        //（.medium/.full/.raw/.preview）はビルドが通らないことを実機ビルドで確認済み。
        // 記録用モデルなので `.reduced` で足ります（計測値はモデルから取っていません）。
        try session.process(requests: [
            .modelFile(url: outputURL, detail: .reduced),
        ])

        for try await output in session.outputs {
            switch output {
            case .requestProgress(_, let fraction):
                onProgress(fraction)
            case .requestComplete:
                onProgress(1.0)
            case .requestError(_, let error):
                throw RunnerError.sessionFailed(error.localizedDescription)
            case .processingComplete:
                return
            case .invalidSample(_, let reason):
                // 1枚使えなくても処理は続くのでログのみ
                print("[Photogrammetry] 使用できない画像: \(reason)")
            case .processingCancelled:
                throw RunnerError.sessionFailed("キャンセルされました")
            default:
                break
            }
        }
    }
}
