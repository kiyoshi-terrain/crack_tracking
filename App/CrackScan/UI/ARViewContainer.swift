import ARKit
import SceneKit
import SwiftUI
import CrackCore

/// AR セッションのカメラ映像を表示する。
struct ARViewContainer: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.session = session
        view.automaticallyUpdatesLighting = true
        view.antialiasingMode = .none
        view.rendersContinuously = true
        view.contentMode = .scaleAspectFill
        return view
    }

    func updateUIView(_ view: ARSCNView, context: Context) {}
}

/// 画像座標 ↔ 画面座標の変換。
///
/// ARKit のキャプチャ画像は常に横長で、画面の向きとは一致しません。
/// `displayTransform` が正規化座標系での対応付けを与えてくれるので、
/// オーバーレイはこれを通して描きます。
enum ARDisplayMapping {

    static func screenPoint(
        imagePoint: Vec2,
        imageSize: CGSize,
        frame: ARFrame,
        orientation: UIInterfaceOrientation,
        viewport: CGSize
    ) -> CGPoint {
        guard imageSize.width > 0, imageSize.height > 0 else { return .zero }
        let normalized = CGPoint(
            x: imagePoint.x / imageSize.width,
            y: imagePoint.y / imageSize.height
        )
        let transform = frame.displayTransform(for: orientation, viewportSize: viewport)
        let mapped = normalized.applying(transform)
        return CGPoint(x: mapped.x * viewport.width, y: mapped.y * viewport.height)
    }

    static func imagePoint(
        screenPoint point: CGPoint,
        imageSize: CGSize,
        frame: ARFrame,
        orientation: UIInterfaceOrientation,
        viewport: CGSize
    ) -> Vec2 {
        guard viewport.width > 0, viewport.height > 0 else { return .zero }
        let normalized = CGPoint(x: point.x / viewport.width, y: point.y / viewport.height)
        let transform = frame.displayTransform(for: orientation, viewportSize: viewport).inverted()
        let mapped = normalized.applying(transform)
        return Vec2(Double(mapped.x) * imageSize.width, Double(mapped.y) * imageSize.height)
    }

    static var currentOrientation: UIInterfaceOrientation {
        let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene
        return scene?.interfaceOrientation ?? .portrait
    }
}
