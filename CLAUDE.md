# Crack Tracking

## プロジェクト概要
構造物のき裂を写真から計測するツール群。用途の異なる2つが入っている。

1. **σ実測ツール（web/）** — き裂の追跡測定で「その機材・その現場で何mmの変化まで
   検出できるか」をブラウザで実測する。高所・非接触の追跡が主用途。端末を問わない。
2. **CrackScan（App/, Sources/）** — iPhone の LiDAR でき裂幅を実寸計測する iOS アプリ。
   LiDAR の実用距離は約3mなので、近接計測専用。

現在の主軸は 1。大谷石構造物のき裂追跡（高所・遠方）が当面の対象。

## ロードマップ

### Phase 1: 測定ノイズの把握
1. ✅ DIC（デジタル画像相関）による変位計測
2. ✅ 円形ターゲットのサブピクセル重心
3. ✅ σ 算出と検出限界（3σ）の提示
4. ✅ 模擬き裂ターゲットシート（A4原寸・既知量の検証用）
5. 🔶 実写での σ 検証（現地撮影待ち）

### Phase 2: 精度の底上げ
6. 🔶 レンズ校正（チェッカーボード）— 三脚の有無より効く
7. 🔶 コード化ターゲットによる自動識別
8. 🔶 大気ゆらぎの評価

### Phase 3: 運用
9. 🔶 経時管理（測点の登録・履歴・有意差判定）
10. 🔶 帳票出力
11. 🔶 温度による見かけの開閉の分離

## 技術スタック
- **web/** — 素の ES モジュール + Canvas。ビルド不要。Node で単体テスト
- **Sources/CrackCore** — Swift。ARKit 非依存の計測ロジック。`swift test` で検証
- **App/CrackScan** — Swift + SwiftUI + ARKit。XcodeGen で生成

## アーキテクチャ

### 計測ロジックを必ず分離する
プラットフォーム API に依存したコードは実機なしで一行も検証できない。
`web/src/*.js` と `Sources/CrackCore` はどちらも
**入出力が数値だけの純粋ロジック**にしてあり、合成画像による回帰テストが書ける。
実際、この分離のおかげで実バグを2件（リッジ検出の極性・平面フィットの法線反転）
実機に触れる前に発見できている。

### ディレクトリ構成
```
web/
  index.html          σ実測ツール本体
  targets/index.html  模擬き裂ターゲットシート（A4原寸印刷）
  src/
    dic.js            ZNCC探索 → 逆合成Gauss-Newton
    targets.js        円形ターゲットの検出と輝度加重重心
    transform.js      アフィン／ホモグラフィのフィット
    sigma.js          σ算出と検出限界
    speckle.js        DIC適性（MIG）とピント判定
    exif.js / image.js
  test/run.mjs        合成画像による検証（34件）

Sources/CrackCore/    Swift の計測ロジック
App/CrackScan/        iOS アプリ
docs/accuracy.md      精度の根拠と限界（実運用前に必読）
```

## 設計上の約束

- **極性を合わせる** — `darkTopHat` の出力では、暗かったき裂が明るい線になる。
  `RidgeDetector` には必ず `polarity` を明示する。誤ると芯線ではなく両脇に応答する。
- **座標系** — `CameraIntrinsics`/`Plane` は画像系（X=右, Y=下, Z=前方）。
  ARKit（X=右, Y=上, Z=後方）との変換は `DepthPlaneEstimator` の一箇所に集約。
- **線形光で測る** — 画素の半分がき裂に覆われたとき、線形光なら値が背景と亀裂の
  ちょうど中間になる。ガンマ符号化のままだと幅が系統的にずれる。
- **精度の主張には必ず検証を添える** — 合成画像で真値を与えて誤差を数値で示す。
  実写で未検証のものは「設計上の目標値」と明記する。

## UI 方針
**ダークアウトドアテーマ（フォレストグリーン + アンバー）** — field-note-app と共通。
現場ツール群として見た目を揃える。数値は必ず等幅・tabular-nums。

## コーディング規約
- コメントと UI は日本語
- web は素の ES モジュール（ビルドツールを増やさない）
- Swift は strict concurrency minimal、View は `@MainActor`

## 開発・実行
```bash
cd web && python3 -m http.server 8080   # σ実測ツール
cd web && node test/run.mjs             # 検証 34件
swift test                              # CrackCore 検証
xcodegen generate                       # iOS アプリの Xcode プロジェクト生成
```
