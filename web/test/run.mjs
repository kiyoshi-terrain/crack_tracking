// node test/run.mjs
//
// DIC・変換フィット・σ算出の検証。ブラウザ非依存の部分だけを対象にしています。

import { integerSearch, refineSubpixel, measureDisplacementField, estimateGlobalShift } from '../src/dic.js';
import { downsample } from '../src/image.js';
import { fitAffine, applyAffine, residuals } from '../src/transform.js';
import { summarize, detectionLimit } from '../src/sigma.js';
import { speckleQuality, focusScore, SATURATED_DARK_LINEAR, SATURATED_BRIGHT_LINEAR } from '../src/speckle.js';
import { makeBlobs, renderBlobs } from './synthetic.mjs';
import { runTargetTests } from './targets.mjs';
import { runPointCloudTests } from './pointcloud.mjs';
import { runSurfaceTests } from './surface.mjs';
import { runHistoryTests } from './history.mjs';
import { runChangeTests } from './change.mjs';
import { runCloudChangeTests } from './cloudchange.mjs';
import { runCaptureTests } from './capture.mjs';
import { runLensCalTests } from './lenscal.mjs';
import { runCloudAlignTests } from './cloudalign.mjs';
import { runParallaxTests } from './parallax.mjs';
import { runCrackLineTests } from './crackline.mjs';
import { readdirSync, readFileSync } from 'node:fs';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  OK   ${name}${detail ? '  ' + detail : ''}`);
  } else {
    failed++;
    console.log(`  NG   ${name}${detail ? '  ' + detail : ''}`);
  }
}

function near(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

const W = 200;
const H = 200;
const blobs = makeBlobs({ width: W, height: H, count: 500, seed: 42 });

// ---------------------------------------------------------------- DIC
console.log('\n== サブピクセル変位の復元 ==');
{
  const reference = renderBlobs(blobs, W, H);
  for (const [u, v] of [[0.37, -0.22], [1.65, 0.83], [-2.4, 3.1], [0.05, 0.05]]) {
    const target = renderBlobs(blobs, W, H, { u, v });
    const coarse = integerSearch(reference, target, 100, 100, 20, 5);
    const fine = refineSubpixel(reference, target, 100, 100, 20, coarse.dx, coarse.dy);
    const eu = fine.dx - u;
    const ev = fine.dy - v;
    check(
      `真値 (${u}, ${v})`,
      Math.abs(eu) < 0.02 && Math.abs(ev) < 0.02,
      `→ (${fine.dx.toFixed(4)}, ${fine.dy.toFixed(4)})  誤差 (${eu.toFixed(4)}, ${ev.toFixed(4)})  zncc=${fine.zncc.toFixed(4)}`
    );
  }
}

console.log('\n== 明るさ・コントラストが変わっても効くか（ZNSSD） ==');
{
  const reference = renderBlobs(blobs, W, H);
  const u = 0.42;
  const v = -0.61;
  const target = renderBlobs(blobs, W, H, { u, v, gain: 1.35, offset: 0.08 });
  const coarse = integerSearch(reference, target, 100, 100, 20, 5);
  const fine = refineSubpixel(reference, target, 100, 100, 20, coarse.dx, coarse.dy);
  check(
    '露出+35%・オフセット+0.08',
    near(fine.dx, u, 0.02) && near(fine.dy, v, 0.02),
    `→ (${fine.dx.toFixed(4)}, ${fine.dy.toFixed(4)})  zncc=${fine.zncc.toFixed(4)}`
  );
}

console.log('\n== ノイズ耐性 ==');
{
  const reference = renderBlobs(blobs, W, H, { noise: 0.01, seed: 1 });
  const u = -0.73;
  const v = 0.28;
  const target = renderBlobs(blobs, W, H, { u, v, noise: 0.01, seed: 2 });
  const coarse = integerSearch(reference, target, 100, 100, 20, 5);
  const fine = refineSubpixel(reference, target, 100, 100, 20, coarse.dx, coarse.dy);
  check(
    'ノイズ振幅1%（8bitで±1.3階調相当）',
    near(fine.dx, u, 0.05) && near(fine.dy, v, 0.05),
    `→ (${fine.dx.toFixed(4)}, ${fine.dy.toFixed(4)})`
  );
}

// ---------------------------------------------------------------- 変位場
console.log('\n== 変位場（一様並進） ==');
{
  const reference = renderBlobs(blobs, W, H);
  const u = 0.31;
  const v = -0.47;
  const target = renderBlobs(blobs, W, H, { u, v });
  const field = measureDisplacementField(reference, target, { subsetHalf: 15, step: 25, searchRange: 3 });
  const us = field.points.map((p) => p.u);
  const vs = field.points.map((p) => p.v);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = (a) => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
  };
  check(
    `測点 ${field.points.length} 点（棄却 ${field.rejected}）`,
    field.points.length > 20 && field.rejected === 0
  );
  check(
    '平均変位が真値に一致',
    near(mean(us), u, 0.01) && near(mean(vs), v, 0.01),
    `→ (${mean(us).toFixed(4)}, ${mean(vs).toFixed(4)})`
  );
  check(
    '測点間のばらつきが小さい',
    sd(us) < 0.02 && sd(vs) < 0.02,
    `σu=${sd(us).toFixed(4)} σv=${sd(vs).toFixed(4)}`
  );
}

console.log('\n== 手持ち相当の大きなずれ（粗いアライメント → 精密化） ==');
{
  const BIG = 420;
  const bigBlobs = makeBlobs({ width: BIG, height: BIG, count: 1800, seed: 5 });
  const reference = renderBlobs(bigBlobs, BIG, BIG);
  const u = 37.4;
  const v = -52.65;
  const target = renderBlobs(bigBlobs, BIG, BIG, { u, v });

  // 粗いアライメント無しでは、狭い探索窓では追えない
  const naive = measureDisplacementField(reference, target, {
    subsetHalf: 15, step: 40, searchRange: 4,
  });
  check(
    '粗いアライメント無しでは追えない',
    naive.points.length === 0 || Math.abs(naive.points[0].u - u) > 1,
    `採用 ${naive.points.length} 点 / 棄却 ${naive.rejected} 点`
  );

  const shift = estimateGlobalShift(reference, target, downsample, { maxShiftPx: 120 });
  check(
    '粗いアライメントが当たる',
    Math.abs(shift.dx - u) <= shift.factor && Math.abs(shift.dy - v) <= shift.factor,
    `→ (${shift.dx}, ${shift.dy})  縮小率 ${shift.factor}  zncc=${shift.confidence.toFixed(3)}`
  );

  const field = measureDisplacementField(reference, target, {
    subsetHalf: 15, step: 40, searchRange: 3, initialShift: shift,
  });
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  check(
    '精密化で真値を復元',
    field.points.length > 10 &&
      near(mean(field.points.map((p) => p.u)), u, 0.02) &&
      near(mean(field.points.map((p) => p.v)), v, 0.02),
    `${field.points.length} 点  → (${mean(field.points.map((p) => p.u)).toFixed(4)}, ${mean(field.points.map((p) => p.v)).toFixed(4)})`
  );
}

// ---------------------------------------------------------------- アフィン
console.log('\n== アフィン変換のフィット ==');
{
  // 既知のアフィン（わずかな回転・拡大・並進）を掛けた対応点
  const truth = { a: 1.0008, b: -0.0025, c: 3.2, d: 0.0025, e: 1.0011, f: -1.7 };
  const points = [];
  for (let y = 20; y < 180; y += 20) {
    for (let x = 20; x < 180; x += 20) {
      const [X, Y] = applyAffine(truth, x, y);
      points.push({ x, y, u: X - x, v: Y - y });
    }
  }
  const fit = fitAffine(points);
  const res = residuals(fit, points);
  const maxResidual = Math.max(...res.map((r) => Math.hypot(r.du, r.dv)));
  check('係数を復元', near(fit.a, truth.a, 1e-9) && near(fit.c, truth.c, 1e-7), `a=${fit.a.toFixed(6)} c=${fit.c.toFixed(4)}`);
  check('残差がゼロ', maxResidual < 1e-9, `max=${maxResidual.toExponential(2)}`);
}

console.log('\n== 変位場からのσ算出（同一画像＝真の変位ゼロ） ==');
{
  const reference = renderBlobs(blobs, W, H, { noise: 0.008, seed: 11 });
  const target = renderBlobs(blobs, W, H, { noise: 0.008, seed: 12 });
  const field = measureDisplacementField(reference, target, { subsetHalf: 15, step: 20, searchRange: 3 });
  const fit = fitAffine(field.points);
  const res = residuals(fit, field.points);
  const stats = summarize(res);
  check(
    'σ が算出できる',
    stats.sigma > 0 && stats.sigma < 0.1,
    `σ=${stats.sigma.toFixed(4)} px  3σ=${(stats.sigma * 3).toFixed(4)} px  n=${stats.count}`
  );
  const limit = detectionLimit({ sigmaPx: stats.sigma, millimetersPerPixel: 0.52 });
  check('mm への換算', limit.detectionLimitMM > 0, `検出限界(3σ) = ${limit.detectionLimitMM.toFixed(4)} mm`);
}

// ---------------------------------------------------------------- テクスチャ品質
console.log('\n== テクスチャ品質（DIC適性） ==');
{
  const textured = renderBlobs(blobs, W, H);
  const flat = { width: W, height: H, data: new Float32Array(W * H).fill(0.5) };
  const q1 = speckleQuality(textured, { subsetHalf: 15 });
  const q2 = speckleQuality(flat, { subsetHalf: 15 });
  check('模様のある面は良判定', q1.verdict !== 'poor', `MIG=${q1.mig.toFixed(5)} 判定=${q1.verdict}`);
  check('平坦な面は不可判定', q2.verdict === 'poor', `MIG=${q2.mig.toFixed(5)} 判定=${q2.verdict}`);
}

console.log('\n== ピント判定（模様の有無と切り分けられるか） ==');
{
  const sharp = renderBlobs(blobs, W, H);
  // 模様は同じでピントだけ甘い画像（斑点を太らせて再描画）
  const softBlobs = blobs.map((b) => ({ ...b, sigma: b.sigma * 3 }));
  const soft = renderBlobs(softBlobs, W, H);
  // 模様が無い平坦面
  const flat = { width: W, height: H, data: new Float32Array(W * H).fill(0.5) };

  const fSharp = focusScore(sharp);
  const fSoft = focusScore(soft);
  check('鋭い画像 > ボケた画像', fSharp > fSoft * 1.5, `鋭 ${fSharp.toFixed(4)} / ボケ ${fSoft.toFixed(4)}`);
  check('平坦面では 0', focusScore(flat) === 0, `${focusScore(flat).toFixed(4)}`);

  // ボケた画像でも「模様はある」と判定される（MIG は残る）＝両者は別の指標
  const qSoft = speckleQuality(soft, { subsetHalf: 15 });
  check(
    'ボケていても模様の有無は別に判定される',
    qSoft.verdict !== 'poor',
    `MIG=${qSoft.mig.toFixed(5)} 判定=${qSoft.verdict}`
  );
}

runTargetTests(check, near);
runPointCloudTests(check, near);
runSurfaceTests(check, near);
runHistoryTests(check, near);
await runChangeTests(check, near);
runCloudChangeTests(check, near);
runCaptureTests(check, near);
runLensCalTests(check, near);
runCloudAlignTests(check, near);
runParallaxTests(check, near);
runCrackLineTests(check, near);

// ---------------------------------------------------------------- 飽和は sRGB で判定
console.log('\n== 飽和の判定（線形光の暗いグレーは黒つぶれではない） ==');
{
  // 暗いが十分な模様: 線形光 0.01〜0.05 の斑点。sRGB では 28〜63/255 に相当し、黒つぶれではない
  const w = 160, h = 160;
  const dark = new Float32Array(w * h);
  let seed = 3;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < dark.length; i++) dark[i] = 0.01 + 0.04 * rnd();
  const qDark = speckleQuality({ width: w, height: h, data: dark }, { subsetHalf: 9 });
  check('線形光 0.01〜0.05 の暗い模様を飽和と数えない', qDark.saturatedRatio < 0.01,
    `飽和 ${(qDark.saturatedRatio * 100).toFixed(2)}%`);
  check('しきい値は sRGB 0.02 / 0.98 の線形光換算',
    near(SATURATED_DARK_LINEAR, 0.00155, 1e-5) && near(SATURATED_BRIGHT_LINEAR, 0.955, 1e-3),
    `${SATURATED_DARK_LINEAR.toFixed(5)} / ${SATURATED_BRIGHT_LINEAR.toFixed(4)}`);
  // 本当に張り付いた領域（真っ黒 0 と真っ白 1 が 15% ずつ）は数える
  const clipped = Float32Array.from(dark);
  for (let i = 0; i < clipped.length * 0.15; i++) clipped[i] = 0;
  for (let i = clipped.length - 1; i > clipped.length * 0.85; i--) clipped[i] = 1;
  const qClip = speckleQuality({ width: w, height: h, data: clipped }, { subsetHalf: 9 });
  check('0 / 1 に張り付いた画素は飽和と数える', qClip.saturatedRatio > 0.29 && qClip.saturatedRatio < 0.31,
    `飽和 ${(qClip.saturatedRatio * 100).toFixed(1)}%`);
  check('飽和が 10% を超えると good は fair に落ちる', qClip.verdict === 'fair' && /白飛び/.test(qClip.reason));
}

// ---------------------------------------------------------------- オフライン
console.log('\n== サービスワーカー ==');
{
  // 1本でも漏れると圏外でその機能だけ静かに動かなくなる。
  // 実際 targets.js が漏れていたので、機械で見張る。
  const modules = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'));
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const missing = modules.filter((m) => !sw.includes(`'./src/${m}'`));
  check('src/ の全モジュールがキャッシュ対象', missing.length === 0,
    missing.length ? `漏れ: ${missing.join(', ')}` : `${modules.length} 本`);
  // 版番号は sw.js の CACHE と version.js の2箇所にある。ずれると画面の版表示が嘘になる
  const ver = readFileSync(new URL('../src/version.js', import.meta.url), 'utf8').match(/'v(\d+)'/)?.[1];
  const cacheVer = sw.match(/sigma-tool-v(\d+)/)?.[1];
  check('版番号が sw.js と version.js で一致', ver && ver === cacheVer, `version.js v${ver} / sw.js v${cacheVer}`);
  // index.html の data-version は「HTML とモジュールの食い違い」検知の基準。
  // ずれたまま配ると、正しい版なのに毎回取り直しに入る
  const htmlVer = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    .match(/<html[^>]*data-version="v(\d+)"/)?.[1];
  check('版番号が index.html とも一致', htmlVer && htmlVer === ver,
    `index.html v${htmlVer} / version.js v${ver}`);
  // 復旧ページはキャッシュ一覧に入れてはいけない（古い SW に捕まって出口にならない）
  check('reset.html はキャッシュ一覧に入れない', !sw.includes("'./reset.html'"));
}

console.log(`\n${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed === 0 ? 0 : 1);
