import SwiftUI
import UIKit

/// 静止画に重ねて描く 1 本の芯線。座標は表示画像の px。
struct StillOverlayLine: Identifiable {
    let id: UUID
    let points: [CGPoint]
    let color: UIColor
    let isSelected: Bool
    let label: String
}

/// ピンチで拡大・2 本指で移動・1 本指でなぞる、計測用の静止画ビュー。
///
/// UIScrollView に任せる。SwiftUI だけだと「1 本指はなぞり、2 本指は移動」を
/// 素直に分けられない。座標はすべて表示画像の px（キャンバスの座標系）で受け渡す。
///
/// 重ね描きはベクタ（CAShapeLayer）で行う。12MP の画像と同じ大きさのビューに
/// `draw(_:)` を実装すると、その大きさのビットマップ（数百 MB）が確保されて落ちる。
struct ZoomableStillView: UIViewRepresentable {
    let image: CGImage
    /// 解析範囲（表示座標）。点線で描く
    let frameRect: CGRect?
    let lines: [StillOverlayLine]
    /// これまでになぞった線（案内として薄く描く）
    let guideStrokes: [[CGPoint]]
    /// なぞり終わり。点列（表示 px）と、画面上の指の大きさに相当する半径（表示 px）
    let onStroke: (_ points: [CGPoint], _ radiusPx: CGFloat) -> Void
    /// タップ。位置（表示 px）と半径（表示 px）
    let onTap: (_ point: CGPoint, _ radiusPx: CGFloat) -> Void

    func makeUIView(context: Context) -> StillScrollView {
        let view = StillScrollView()
        view.onStroke = onStroke
        view.onTap = onTap
        view.setImage(image)
        return view
    }

    func updateUIView(_ view: StillScrollView, context: Context) {
        view.onStroke = onStroke
        view.onTap = onTap
        if view.canvas.image !== image {
            view.setImage(image)
        }
        view.canvas.overlay.update(lines: lines, frameRect: frameRect, guideStrokes: guideStrokes)
    }
}

/// スクロール・ズームと、1 本指の入力を受ける。
final class StillScrollView: UIScrollView, UIScrollViewDelegate {
    let canvas = StillCanvasView()
    var onStroke: (([CGPoint], CGFloat) -> Void)?
    var onTap: ((CGPoint, CGFloat) -> Void)?

    /// 画面上の指の大きさ（pt）。探索半径をこれから換算する
    private let fingerPoints: CGFloat = 28
    private var needsInitialFit = true
    private var strokePoints: [CGPoint] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        backgroundColor = .black
        showsVerticalScrollIndicator = false
        showsHorizontalScrollIndicator = false
        bouncesZoom = true
        contentInsetAdjustmentBehavior = .never
        // 移動は 2 本指。1 本指はなぞりに使う
        panGestureRecognizer.minimumNumberOfTouches = 2
        addSubview(canvas)

        let stroke = UIPanGestureRecognizer(target: self, action: #selector(handleStroke(_:)))
        stroke.maximumNumberOfTouches = 1
        canvas.addGestureRecognizer(stroke)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        canvas.addGestureRecognizer(tap)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func setImage(_ image: CGImage) {
        canvas.image = image
        let size = CGSize(width: image.width, height: image.height)
        zoomScale = 1
        canvas.frame = CGRect(origin: .zero, size: size)
        contentSize = size
        needsInitialFit = true
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0, canvas.bounds.width > 0 else { return }
        let fit = min(bounds.width / canvas.bounds.width, bounds.height / canvas.bounds.height)
        minimumZoomScale = fit
        maximumZoomScale = max(2.0, fit * 10)
        if needsInitialFit {
            needsInitialFit = false
            zoomScale = fit
        }
        centerContent()
        canvas.overlay.zoomScale = zoomScale
    }

    private func centerContent() {
        let dx = max(0, (bounds.width - contentSize.width) / 2)
        let dy = max(0, (bounds.height - contentSize.height) / 2)
        contentInset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
    }

    // MARK: UIScrollViewDelegate

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { canvas }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerContent()
        canvas.overlay.zoomScale = zoomScale
    }

    // MARK: 入力

    @objc private func handleStroke(_ gesture: UIPanGestureRecognizer) {
        let point = gesture.location(in: canvas)
        switch gesture.state {
        case .began:
            strokePoints = [point]
            canvas.overlay.liveStroke = strokePoints
        case .changed:
            if let last = strokePoints.last, hypot(point.x - last.x, point.y - last.y) >= 2 / max(zoomScale, 0.01) {
                strokePoints.append(point)
            }
            canvas.overlay.liveStroke = strokePoints
        case .ended:
            strokePoints.append(point)
            let points = strokePoints
            strokePoints = []
            canvas.overlay.liveStroke = []
            if points.count >= 2 {
                onStroke?(points, fingerPoints / max(zoomScale, 0.01))
            }
        case .cancelled, .failed:
            strokePoints = []
            canvas.overlay.liveStroke = []
        default:
            break
        }
    }

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        onTap?(gesture.location(in: canvas), fingerPoints / max(zoomScale, 0.01))
    }
}

/// 画像と重ね描きを同じ座標系（表示画像の px）に置くための入れ物。
final class StillCanvasView: UIView {
    private let imageView = UIImageView()
    let overlay = StillOverlayView()

    var image: CGImage? {
        didSet { imageView.image = image.map { UIImage(cgImage: $0) } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleToFill
        addSubview(imageView)
        addSubview(overlay)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        imageView.frame = bounds
        overlay.frame = bounds
    }
}

/// 芯線・枠・なぞった線をベクタで重ねる。線幅と文字はズームに合わせて画面上で一定にする。
final class StillOverlayView: UIView {
    private(set) var lines: [StillOverlayLine] = []
    private(set) var frameRect: CGRect?
    private(set) var guideStrokes: [[CGPoint]] = []

    var zoomScale: CGFloat = 1 {
        didSet { if abs(zoomScale - oldValue) > 1e-6 { render() } }
    }

    /// なぞっている途中の線。これだけは毎フレーム変わるので専用レイヤーを持つ
    var liveStroke: [CGPoint] = [] {
        didSet {
            liveStrokeLayer.path = Self.path(liveStroke)
            liveStrokeLayer.lineWidth = 6 / max(zoomScale, 0.01)
        }
    }

    private let liveStrokeLayer = CAShapeLayer()
    private var staticLayers: [CALayer] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        liveStrokeLayer.strokeColor = UIColor.systemYellow.withAlphaComponent(0.85).cgColor
        liveStrokeLayer.fillColor = UIColor.clear.cgColor
        liveStrokeLayer.lineCap = .round
        liveStrokeLayer.lineJoin = .round
        layer.addSublayer(liveStrokeLayer)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func update(lines: [StillOverlayLine], frameRect: CGRect?, guideStrokes: [[CGPoint]]) {
        self.lines = lines
        self.frameRect = frameRect
        self.guideStrokes = guideStrokes
        render()
    }

    private func render() {
        staticLayers.forEach { $0.removeFromSuperlayer() }
        staticLayers = []
        let s = max(zoomScale, 0.01)

        if let frameRect {
            let shape = CAShapeLayer()
            shape.path = UIBezierPath(rect: frameRect).cgPath
            shape.strokeColor = UIColor.white.withAlphaComponent(0.6).cgColor
            shape.fillColor = UIColor.clear.cgColor
            shape.lineWidth = 1.5 / s
            shape.lineDashPattern = [NSNumber(value: Double(8 / s)), NSNumber(value: Double(6 / s))]
            add(shape)
        }

        for stroke in guideStrokes where stroke.count >= 2 {
            let shape = CAShapeLayer()
            shape.path = Self.path(stroke)
            shape.strokeColor = UIColor.systemYellow.withAlphaComponent(0.3).cgColor
            shape.fillColor = UIColor.clear.cgColor
            shape.lineWidth = 12 / s
            shape.lineCap = .round
            shape.lineJoin = .round
            add(shape)
        }

        let screenScale = UIScreen.main.scale
        for line in lines where line.points.count >= 2 {
            let shape = CAShapeLayer()
            shape.path = Self.path(line.points)
            shape.strokeColor = line.color.withAlphaComponent(line.isSelected ? 1 : 0.45).cgColor
            shape.fillColor = UIColor.clear.cgColor
            shape.lineWidth = (line.isSelected ? 4 : 2.5) / s
            shape.lineCap = .round
            shape.lineJoin = .round
            add(shape)

            // ラベル（幅）。芯線の中ほどの右に置く
            let anchor = line.points[line.points.count / 2]
            let fontSize = 13 / s
            let font = UIFont.systemFont(ofSize: fontSize, weight: .bold)
            let textSize = (line.label as NSString).size(withAttributes: [.font: font])
            let pad = 5 / s
            let text = CATextLayer()
            text.string = line.label
            text.font = font
            text.fontSize = fontSize
            text.foregroundColor = UIColor.white.cgColor
            text.alignmentMode = .center
            text.contentsScale = screenScale * s
            text.backgroundColor = line.color.withAlphaComponent(line.isSelected ? 0.9 : 0.5).cgColor
            text.cornerRadius = (textSize.height + pad * 2) / 2
            text.frame = CGRect(
                x: anchor.x + 10 / s,
                y: anchor.y - textSize.height / 2 - pad,
                width: textSize.width + pad * 2,
                height: textSize.height + pad * 2
            )
            // 文字を縦方向の中央に置く（CATextLayer は上寄せ）
            text.bounds = CGRect(x: 0, y: -pad, width: text.frame.width, height: text.frame.height)
            add(text)
        }
    }

    private func add(_ sublayer: CALayer) {
        layer.insertSublayer(sublayer, below: liveStrokeLayer)
        staticLayers.append(sublayer)
    }

    private static func path(_ points: [CGPoint]) -> CGPath? {
        guard points.count >= 2 else { return nil }
        let path = UIBezierPath()
        path.move(to: points[0])
        for p in points.dropFirst() { path.addLine(to: p) }
        return path.cgPath
    }
}
