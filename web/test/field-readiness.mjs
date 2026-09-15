import { calibratedTargetPairs, targetScalePair, validateTargetIds } from '../src/targetmeasurement.js';
import { fitTransformRobust, measureEpochChange, stableSubset } from '../src/change.js';
import { residuals } from '../src/transform.js';
import { crackOpening, crackOpeningEpoch } from '../src/crackline.js';
import { createStation, addObservation, serialize, deserialize } from '../src/history.js';
import { makeBlobs, renderBlobs } from './synthetic.mjs';
import { downsample } from '../src/image.js';

export async function runFieldReadinessTests(check, near) {
  console.log('\n== 現地準備: 現地ID・縮尺・履歴 ==');
  const pairs = [{ i: 0, j: 1, distance: 100 }, { i: 0, j: 2, distance: 120 }, { i: 1, j: 2, distance: 156 }];
  const ids = [{ id: 'L1', member: '石A' }, { id: 'L2', member: '石A' }, { id: 'R1', member: '石B' }];
  const factors = [1, 1.01, 0.99, 1.02];
  const series = [100, 120, 156].map((d) => factors.map((f) => d * f));
  check('き裂をまたぐ縮尺対を拒否', !targetScalePair(pairs, ids, '0-2', 120));
  check('部材IDなしを拒否', !targetScalePair(pairs, ids.map((a) => ({ ...a, member: '' })), '0-1', 100));
  check('現地ID重複を拒否', !!validateTargetIds([ids[0], ids[0]]));
  check('現地ID未確認では履歴用の値を出さない', calibratedTargetPairs(pairs, series, ids.map((a) => ({ ...a, id: '' })), '0-1', 100).length === 0);
  const rows = calibratedTargetPairs(pairs, series, ids, '0-1', 100);
  check('縮尺対自身は計測対象から除外', rows.length === 2 && rows.every((r) => r.label !== 'L1 ↔ L2'));
  check('1〜2%の倍率変動を同一フレーム内の比で相殺', near(rows[0].meanMM, 120, 1e-9));
  check('同一画像相当でも誤差床は0にしない', rows[0].sigmaMM > 0);
  const moved = calibratedTargetPairs(pairs, [series[0], factors.map((f) => 120.1 * f), series[2]], ids, '0-1', 100);
  check('既知の0.1mm増加を復元', near(moved[0].meanMM - rows[0].meanMM, 0.1, 1e-9));
  const missing = calibratedTargetPairs(pairs, [[100, NaN, 100], [120, 999, 120], [156, 999, 156]], ids, '0-1', 100);
  check('縮尺対欠測フレームは計測にも使わない', missing[0].frames === 2 && near(missing[0].meanMM, 120, 1e-9));
  check('有効1枚では履歴用σを作らない', calibratedTargetPairs(pairs, [[100], [120], [156]], ids, '0-1', 100).length === 0);
  // 検出番号の順を入れ替えても、手で照合した現地IDが同じなら同じ履歴キー。
  const permIds = [ids[2], ids[1], ids[0]];
  const permRows = calibratedTargetPairs(pairs, [series[2], series[1], series[0]], permIds, '1-2', 100);
  check('検出順が変わっても現地IDで同一ペアと認識', permRows.find((r) => r.label === 'L1 ↔ R1').sourceKey === rows[0].sourceKey);
  let st = createStation({ name: '試験' });
  st = addObservation(st, { at: '2026-09-01', valueMM: rows[0].meanMM, sourceKey: rows[0].sourceKey });
  st = addObservation(st, { at: '2026-09-02', valueMM: moved[0].meanMM, sourceKey: moved[0].sourceKey });
  check('同じ現地IDと縮尺で履歴を追加', st.observations.length === 2);
  let rejected = false;
  try { addObservation(st, { valueMM: 156, sourceKey: rows[1].sourceKey }); } catch { rejected = true; }
  check('別のペアを同じ測点に混ぜない', rejected);
  rejected = false;
  try { addObservation(st, { valueMM: 120 }); } catch { rejected = true; }
  check('IDなしの旧方式を混ぜない', rejected);
  check('JSON往復で計測対象を保持', deserialize(serialize([st]))[0].observations[0].sourceKey === rows[0].sourceKey);

  console.log('\n== 現地準備: 正しい残差でDICの段差を検証 ==');
  const pts = [];
  for (let y = 40; y < 800; y += 40) for (let x = 40; x < 1000; x += 40)
    pts.push({ x, y, u: x > 500 ? 0.75 : 0, v: 0 });
  const line = { x1: 500, y1: 0, x2: 500, y2: 800 };
  const extract = (fit) => crackOpening(residuals(fit.transform, pts), line, { margin: 26, depth: 160 });
  const auto = extract(fitTransformRobust(pts, true));
  const stable = extract(fitTransformRobust(pts.filter((p) => p.x < 450), true));
  check('全体フィットで過小評価が再現（既知の制約）', auto.openingPx < 0.6, `${auto.openingPx.toFixed(4)} px / 真値0.75`);
  check('片側の安定域では段差を保存', near(stable.openingPx, 0.75, 1e-8));
  check('安定域境界をまたぐサブセットを除外', !stableSubset((x) => x < 200, 195, 100, 12));

  console.log('\n== 現地準備: 画像から2段階DICまで ==');
  const W = 480, H = 360;
  const blobs = makeBlobs({ width: W, height: H, count: 1800, seed: 342 });
  const ref = renderBlobs(blobs, W, H);
  const angle = 0.4 * Math.PI / 180;
  const frames = [21, 22].map((seed) => renderBlobs(blobs.map((b) => {
    const u = b.x > W / 2 ? 0.75 : 0;
    return { ...b, x: (b.x + u) * Math.cos(angle) - b.y * Math.sin(angle) + 2,
      y: (b.x + u) * Math.sin(angle) + b.y * Math.cos(angle) - 2 };
  }), W, H, { noise: 0.002, seed }));
  const opts = { subsetHalf: 10, step: 20, coarseSearch: 10, downsample, useHomography: true,
    stableRegion: (x) => x < 205, sigmaAPx: 0.01 };
  for (const coarseScale of [1, 2]) {
    const result = await measureEpochChange(ref, frames, { ...opts, coarseScale });
    check(`安定域指定で画像比較成立 縮小${coarseScale}`, result.ok && result.stableRegionSpecified);
    if (!result.ok) continue;
    const op = crackOpeningEpoch(result.cells, { x1: 240, y1: 50, x2: 240, y2: 310 }, { margin: 25, depth: 70 });
    check(`開口の符号と量を復元 縮小${coarseScale}`, op.ok && near(op.openingPx, 0.75, 0.08), `${op.openingPx?.toFixed(4)} px`);
    check(`両段階で安定点を使用 縮小${coarseScale}`, result.frames.every((f) => f.coarseStableUsed > 0 && f.stableUsed > 0));
  }
  const failed = await measureEpochChange(ref, [frames[0]], { ...opts, stableRegion: () => false });
  check('安定域不足で全体フィットへ黙って戻らない', !failed.ok && failed.reason.includes('安定域'));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  let passed = 0, failed = 0;
  await runFieldReadinessTests((name, ok, detail = '') => {
    console.log(`${ok ? 'OK' : 'NG'} ${name} ${detail}`); ok ? passed++ : failed++;
  }, (a, b, t) => Math.abs(a - b) <= t);
  console.log(`${passed} 件成功 / ${failed} 件失敗`);
  process.exitCode = failed ? 1 : 0;
}
