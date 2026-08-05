# アーキテクチャ

## 全体構成

```
┌──────────────────────────────────────────────────────┐
│ App/CrackScan  (iOS 専用・ARKit / SwiftUI)            │
│                                                      │
│  UI ──── CaptureView / ProjectDetailView / …         │
│   │                                                  │
│  Capture ── ARCaptureController                      │
│   │          DepthPlaneEstimator  (LiDAR → 平面)      │
│   │          FrameBundleWriter    (画像/深度/メタ保存) │
│   │                                                  │
│  Measure ── MeasureViewModel                         │
│   │          CrackMeasurementService (actor)         │
│   │                                                  │
│  その他 ── PhotogrammetryRunner / PDFReportRenderer   │
│            ProjectStore / ImageConversion            │
└───────────────────────┬──────────────────────────────┘
                        │ 依存は一方向のみ
┌───────────────────────▼──────────────────────────────┐
│ Sources/CrackCore  (Foundation のみに依存)            │
│                                                      │
│  Geometry     Vec2/Vec3, CameraIntrinsics,           │
│               Plane, PlaneFitter, SurfaceScale       │
│  Imaging      GrayImage, ImageFilters                │
│  Detection    RidgeDetector, RidgeThresholder,       │
│               Skeletonizer, PolylineTracer,          │
│               CrackDetector                          │
│  Measurement  WidthEstimator, PointSpreadCorrection  │
│  Capture      CaptureQualityEvaluator, CoveragePlanner│
│  Domain       InspectionProject / CaptureSession /   │
│               CrackRecord / CrackGrade               │
│  Export       CSVExporter                            │
└──────────────────────────────────────────────────────┘
```

### なぜ CrackCore を分けているか

計測ロジックが ARKit に依存していると、**実機なしでは一行も検証できません**。
CrackCore は Foundation のみに依存させ、`swift test` で
Mac 上（および CI）で動かせるようにしています。
既知幅の合成画像を入力にした回帰テストが書けるのはこの分離のおかげです。

---

## 計測の流れ

```
        ┌─── ARFrame (高解像度) ───┐
        │                          │
   capturedImage              sceneDepth
        │                          │
        ▼                          ▼
 ImageConversion            DepthPlaneEstimator
 (Yプレーン → 線形光)        (デプス → ロバスト平面フィット)
        │                          │
        │      ┌───────────────────┘
        ▼      ▼
   CrackDetector ← SurfaceScale(intrinsics, plane)
        │
        ├─ darkTopHat        照明ムラ除去
        ├─ RidgeDetector     マルチスケール・ヘッセ行列
        ├─ RidgeThresholder  非極大抑制 + ヒステリシス
        ├─ Skeletonizer      Zhang-Suen 細線化
        ├─ PolylineTracer    枝分割・スパー除去・平滑化
        └─ WidthEstimator    断面の半値幅 + PSF補正 + mm換算
        │
        ▼
   CrackMeasurement → CrackRecord → CSV / PDF
```

### 座標系の約束

混乱しやすいので明示します。

| 用途 | 座標系 |
|---|---|
| `CameraIntrinsics` / `Plane` / `SurfaceScale` | **画像系カメラ座標**: X=右, Y=下, Z=前方（奥行きが正） |
| `ARFrame.camera.transform` | **ARKit カメラ座標**: X=右, Y=上, Z=後方 |
| ワールド位置の保存 | ARKit ワールド座標（重力基準） |

変換は `DepthPlaneEstimator.worldPosition(ofCameraPoint:frame:)` の一箇所に集約してあります。
ここを介さずに直接変換を書かないでください（Y/Z の符号を落として上下逆になります）。

### リッジ検出の極性の約束

もう一つ、静かに間違いやすい箇所です。

`ImageFilters.darkTopHat` の出力は「背景よりどれだけ暗いか」なので、
**入力で暗かったひび割れは出力では明るい線になります。**
そのため `RidgeDetector.compute` には `polarity: .brightLine` を渡します。

`.darkLine` のまま渡すと、芯線（曲率が負）の応答が捨てられ、
曲率が正になる**線の両脇**だけが残ります。見た目には「それらしい線」が
2本検出されるため気づきにくく、位置が数 px ずれます。
`testRidgePolarityMustMatchTheInput` がこれを固定しています。

---

## 計測と 3D モデルの役割分担

このアプリは 2 系統の出力を持ちますが、**目的が違います**。

| | ひび割れ幅の計測 | 写真測量 3D モデル |
|---|---|---|
| 入力 | 高解像度画像 + LiDAR 平面 | 画像群 |
| 実装 | `CrackMeasurementService` | `PhotogrammetryRunner` |
| 分解能 | サブピクセル（0.05mm オーダー） | メッシュ頂点間隔（cm オーダー） |
| 用途 | 帳票に載る計測値 | 位置の記録・次回点検との比較 |

**幅の値をメッシュから取ってはいけません。** 写真測量メッシュの頂点間隔は
ミリ幅の計測には桁が足りません。3D モデルは「どの部位のどこにあったか」を
残すためのものです。

---

## 保存フォーマット

案件ごとに 1 フォルダ。フォルダごと共有すれば全データが持ち出せます。

```
Documents/Projects/<projectID>/
├── project.json                    案件・セッション・ひび割れ記録
└── Sessions/<sessionID>/
    ├── Images/frame_0000.heic      カラー画像
    ├── Depth/frame_0000.tif        Float32 デプス
    ├── Meta/frame_0000.json        内部パラメータ・姿勢・露出
    └── model.usdz                  Object Capture の生成物
```

`Meta/*.json` に内部パラメータと姿勢を素の数値で残しているので、
外部の SfM や写真測量ソフトへ持ち出してもスケール基準を引き継げます。

---

## 並行処理

- `ARCaptureController` / `ProjectStore` / `MeasureViewModel` は `@MainActor`。
- 重い画像解析は `CrackMeasurementService`（actor）に隔離し、
  UI からは `await` で呼びます。
- ライブ評価は 0.2 秒間隔にスロットルしています。
  毎フレーム平面フィットを走らせると発熱でカメラが落ちます。

---

## 拡張するときの入口

| やりたいこと | 触る場所 |
|---|---|
| 検出アルゴリズムを差し替える | `CrackDetector.detect` |
| 幅の定義を変える（例: 積分法） | `WidthEstimator.halfMaximumWidth` |
| 判定区分を要領に合わせる | `InspectionProject.gradeThresholds` |
| 帳票の様式を変える | `PDFReportRenderer` |
| CSV の列を増やす | `CSVExporter.makeCSV` |
| 撮影ガイドの厳しさを変える | `CaptureQualityEvaluator.Thresholds` |
