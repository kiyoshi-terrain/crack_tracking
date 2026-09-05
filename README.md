# crack_tracking

構造物のひび割れ・き裂を写真から計測するためのツール群です。用途の異なる2つが入っています。

## 🔗 σ実測ツール（ブラウザで今すぐ動きます）

### **→ https://kiyoshi-terrain.github.io/crack_tracking/**
### 取扱説明書: **https://kiyoshi-terrain.github.io/crack_tracking/manual/**

**き裂の追跡測定で、その機材・その現場で何mmの変化まで検出できるか**を実測し、
測点として登録して経時変化を追います。

同じ場所から連続撮影した写真を2枚以上ドロップするだけ。構造物は数分では動かないので、
そこで出た「変位」がそのまま測定ノイズ σ です。3σ が実質的な検出限界になります。

- **カメラアプリ型の画面**（常時ビューファインダー + HUD）。判断に要る数値は常に画面にあります
- **点群（PLY / LAS）を読めます** — スケールと斜め補正が自動で決まり、
  写真には出ない**面外のはらみ出し**（剥落の前兆）が測れます
- **経時管理** — 測点を登録して前回との差を有意判定。
  **温度による見かけの開閉**は測点自身のデータから分離します
- インストール不要。**画像はブラウザ内で処理され、外部に送信されません**
- **オフラインで動きます** — 一度開けば圏外の現場でも使えます
- iPhone / Android / ミラーレスを問いません（端末固有 API に依存しない設計）
- 高所・非接触の追跡測定を想定。LiDAR も三脚も必須ではありません

→ 詳細と撮影プロトコル: **[web/README.md](web/README.md)**

ローカルで動かす場合:

```bash
cd web && python3 -m http.server 8080   # → http://localhost:8080
node test/run.mjs                        # アルゴリズムの検証（249件）
```

---

## 📱 CrackScan（iOS アプリ）

iPhone の LiDAR とカメラで、構造物壁面のひび割れ幅を**実寸（mm）で計測**する iOS アプリです。

撮影した瞬間に「1px が何 mm か」が確定するので、その場で幅が出ます。

> **適用範囲に注意**: LiDAR の実用距離は約3mです。**高所・遠方の計測には使えません。**
> そちらは上の σ実測ツール（画像相関＋ターゲット方式）の系統になります。
> 手の届く低所、または高所作業車で近接できる場面向けです。

---

## できること

| | |
|---|---|
| **その場で幅を測る** | 画面の枠を壁に向けて「計測」を押すと、枠内のひび割れを自動検出して幅・延長を mm で表示 |
| **撮影ガイド** | 分解能（mm/px）・距離・入射角を常時表示。目標幅を測れない位置では具体的に「◯m まで近づいて」と指示 |
| **撮り逃し防止** | ピンボケ・白飛び・急角度・トラッキング不安定を検出して撮影をブロック |
| **3D 記録** | Object Capture で壁面の 3D モデル（USDZ）を生成し、位置の記録に使う |
| **帳票出力** | 点検調書 PDF（一覧 + 写真付き明細）と Excel 互換 CSV |
| **手入力上書き** | クラックスケールで実測した値があれば、そちらを優先して帳票に載せる |

---

## 動作要件

- **LiDAR 搭載の iPhone / iPad**（iPhone 12 Pro 以降の Pro / Pro Max、iPad Pro）
  - LiDAR がないとスケールの基準が取れず、実寸計測ができません
- iOS 17.0 以降
- ビルド: **Xcode 16 以降**（XcodeGen が生成する pbxproj が Xcode 16 形式のため。
  Xcode 15 で開くと "future Xcode project file format" エラーになります）

---

## ビルド方法

`.xcodeproj` はリポジトリに含めていません（pbxproj のコンフリクトを避けるため）。
[XcodeGen](https://github.com/yonaskolb/XcodeGen) で生成します。

```bash
brew install xcodegen
xcodegen generate
open CrackScan.xcodeproj
```

実機で動かすには署名の Team ID が要ります。`project.yml` は触らず、手元にだけ置く
`Local.xcconfig` に書きます（`.gitignore` 済みなので `git pull` と衝突しません）。

```bash
cp Local.xcconfig.example Local.xcconfig
# DEVELOPMENT_TEAM = 自分の Team ID に書き換える（Xcode → Settings → Accounts で確認）
xcodegen generate
```

更新を取り込むときは `git pull && xcodegen generate` の 2 つだけです。
Xcode の ▶（Debug）でも計測ロジック `CrackCore` は最適化ビルド（-O）になります。
純 Swift の画像処理は最適化なしだと 10〜30 倍遅く、現場で「解析中…」が 1 分続くためです。

### 計測ロジックのテスト

計測アルゴリズムは ARKit に依存しない `CrackCore` に分離してあるので、
実機もシミュレータも要らず Mac 上でそのまま走ります。

```bash
swift test
```

既知幅の合成ひび割れ画像を入力に、幅・スケール・検出を検証しています。

> ルートの `Package.swift` と `project.yml` は同じ `Sources/CrackCore` を参照します。
> 前者は CI で `swift test` を直接回すため、後者は Xcode 上で framework として
> アプリにリンクするためのものです。

---

## まず読むべきドキュメント

- **[docs/accuracy.md](docs/accuracy.md)** — 精度の根拠と限界。
  **どの距離から撮れば何 mm まで測れるか**が書いてあります。実運用の前に必読。
- [docs/architecture.md](docs/architecture.md) — 構成と座標系の約束、拡張の入口。

---

## いちばん重要な制約

ひび割れ幅の計測精度は、レンズの良し悪しではなく **GSD（mm/px）** で決まります。
幅 w を測るにはひび割れが最低 3px に写っている必要があり、距離に直すと:

| 撮影解像度 | 0.2mm を測れる距離 | 0.5mm を測れる距離 |
|---|---|---|
| 12MP | **0.20 m** | 0.50 m |
| 48MP | **0.40 m** | 1.00 m |

つまり **離れた場所から 0.2mm のひび割れは測れません**。物理的な限界です。

そのため運用は 2 段構えを想定しています。

1. **広域スキャン**（1〜3m）— 位置と延長を面的に記録。幅は 0.5mm 以上のみ有効
2. **近接計測**（0.2〜0.5m）— 要注意箇所に寄って幅を確定

アプリは 3px 未満でしか写っていないひび割れを自動的に「参考値」と判定し、
画面・CSV・PDF のすべてに明示します。この値を根拠に健全性の判定をしないでください。

---

## 使い方

1. **案件を作る** — 案件名・構造物名・点検者と、**目標ひび割れ幅**を設定。
   目標幅は「測りたい幅の級」で、撮影ガイドのしきい値と、検出器が狙う幅
   （この幅の 0.8〜4 倍）の両方を決めます。石積みの開口なら 1〜3 mm、
   コンクリートのひび割れなら 0.2〜0.3 mm。案件画面で後から変えられます
2. **部材名を入れて撮影開始** — 「橋脚 P3 west 面」など
3. **枠を壁に向ける** — HUD の分解能が緑になるまで近づく
4. **「計測」を押す** — 高解像度フレームを取り直して解析し、検出結果を重ねて表示
5. **記録するひび割れを選ぶ** — チップをタップして選択を切り替え、「記録」
6. **「記録」ボタンで写真も残す** — 3D モデル生成や再解析のための元データ
7. **案件画面から CSV / PDF を書き出す**

画面の枠は**実際に解析する範囲**です。枠を画像座標へ写し、解析できる画素数の上限で
中心から縮めた結果を描いています。枠の外にある亀裂は検出しません。

### 実機で確かめる（現地の前に）

幅が分かっている線を測って、自分の端末で何 mm がいくらと出るかを一度見てください。

- **[クラックゲージシート](https://kiyoshi-terrain.github.io/crack_tracking/gauge/)** —
  0.3〜5.0 mm の線とくさびを A4 原寸で印刷する検証用シート（`web/gauge/`）。
  平らな壁に貼り、0.3〜0.5 m から測ります。印刷の線は 0.03〜0.05 mm 太るので、
  0.3 mm 未満は市販のクラックスケールで
- 一貫して太く／細く出るなら `WidthEstimator.Options.psfSigmaPx` を
  [docs/accuracy.md §8](docs/accuracy.md) の手順で校正します

---

## リポジトリ構成

```
web/                   σ実測ツール（ブラウザ完結・端末非依存）
  index.html           → https://kiyoshi-terrain.github.io/crack_tracking/
  targets/             模擬き裂ターゲットシート（A4原寸印刷・検証用）
  gauge/               クラックゲージシート（CrackScan の幅計測の検証用・A4原寸）
  manual/              取扱説明書（オフライン・印刷可）
  src/dic.js           デジタル画像相関（ZNCC + 逆合成Gauss-Newton）
  src/targets.js       円形ターゲットの検出と輝度加重重心
  src/transform.js     アフィン／ホモグラフィのフィット
  src/sigma.js         σ算出と検出限界
  src/speckle.js       DIC適性の定量判定（MIG）とピント判定
  src/pointcloud.js    PLY/LAS読込・ロバスト平面フィット・面外マップ
  src/surface.js       平面 → 写真の mm/px（斜め補正）・剥落リスク
  src/history.js       測点・2時期比較・傾き・温度分離
  src/shell.js         カメラ風シェル（HUD・レール・シート）
  src/exif.js          焦点距離の抽出と複数枚の整合性検証
  test/run.mjs         合成データによる検証（249件）

Sources/CrackCore/     計測アルゴリズム（ARKit 非依存・テスト可能）
  Geometry/            カメラ幾何・平面フィット・px→mm 換算
  Imaging/             画像バッファとフィルタ
  Detection/           リッジ検出・細線化・ポリライン化
  Measurement/         断面の半値幅による幅推定
  Capture/             撮影品質判定・撮影計画
  Domain/ Export/      点検データモデルと CSV 出力

App/CrackScan/         iOS アプリ
  Capture/             ARKit セッション・LiDAR 平面推定・フレーム保存
  Measure/             計測サービスと画面用 ViewModel
  Imaging/             CVPixelBuffer 変換（線形光への復元を含む）
  Photogrammetry/      Object Capture による 3D モデル生成
  Persistence/ Report/ ファイル保存と PDF 調書
  UI/                  SwiftUI 画面

Tests/CrackCoreTests/  合成画像を使った検証テスト
docs/                  精度設計・アーキテクチャ
```

---

## 免責

本アプリは計測値を提示するツールであり、構造物の健全性判定を代替するものではありません。
判定区分の既定しきい値（0.2 / 0.3 / 0.5mm）は一般的な目安として並べたもので、
適用すべき基準は発注者・構造物種別・点検要領によって異なります。
案件ごとに `InspectionProject.gradeThresholds` を設定してください。
