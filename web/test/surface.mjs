// 点群の平面 → 写真の mm/px の橋渡しを検証する。
// 幾何が閉じているので、真値は手計算で出せる。

import { fitWallPlane } from '../src/pointcloud.js';
import {
  cameraFromPlane, rayThroughPixel, intersectPlane,
  pixelScale, frameScaleSummary, spallingRisk,
} from '../src/surface.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * x = wallX に立つ壁を、**壁自身の中心のまわりで** yaw だけ振る。視点は原点。
 *
 * 原点まわりで回すと壁が横に移動するだけで、視点は法線上に留まったまま
 * 斜角が生じない。斜め撮影を作るには壁を「その場で」振る必要がある。
 */
function makeWall({ count = 20000, seed = 7, noise = 0.002, wallX = 5, yawDeg = 0 } = {}) {
  const rnd = mulberry32(seed);
  const a = (yawDeg * Math.PI) / 180;
  const pts = new Float64Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const y = -2 + rnd() * 4;
    const z = -2 + rnd() * 4;
    const x = (rnd() - 0.5) * 2 * noise;   // 壁中心を原点とした局所座標
    pts[i * 3] = wallX + (x * Math.cos(a) - y * Math.sin(a));
    pts[i * 3 + 1] = x * Math.sin(a) + y * Math.cos(a);
    pts[i * 3 + 2] = z;
  }
  return pts;
}

function centroid(points) {
  const c = [0, 0, 0];
  const n = points.length / 3;
  for (let p = 0; p < points.length; p += 3) {
    c[0] += points[p]; c[1] += points[p + 1]; c[2] += points[p + 2];
  }
  return c.map((v) => v / n);
}

export function runSurfaceTests(check, near) {
  const W = 4032, H = 3024;
  const F = 3200;                       // iPhone 広角の実測相当
  const intrinsics = { focalLengthPx: F, cx: W / 2, cy: H / 2 };

  console.log('\n== 正対したときの mm/px ==');
  {
    const pts = makeWall({ yawDeg: 0, seed: 3 });
    const plane = fitWallPlane(pts);
    const camera = cameraFromPlane(plane, centroid(pts));

    // 距離 5m・焦点距離 3200px → 中央で 5000/3200 = 1.5625 mm/px
    const s = pixelScale(camera, plane, intrinsics, W / 2, H / 2);
    check('中央の mm/px', near(s.mmPerPx, 1.5625, 0.002), `${s.mmPerPx.toFixed(4)} mm/px`);
    check('等方（正対なので縦横が同じ）', near(s.mmPerPxX, s.mmPerPxY, 1e-6),
      `X ${s.mmPerPxX.toFixed(5)} / Y ${s.mmPerPxY.toFixed(5)}`);
    // 重心は乱数の平均なので厳密には壁の中心から数 mm ずれる（20000点で 8mm ≒ 0.09°）
    check('斜角 0°', s.obliquityDeg < 0.2, `${s.obliquityDeg.toFixed(3)}°`);
    check('距離 5000mm', near(s.distanceMM, 5000, 3), `${s.distanceMM.toFixed(1)} mm`);
  }

  console.log('\n== 画面の端では mm/px が変わる ==');
  {
    // 正対でも端の画素は斜めに当たる。cos の3乗ぶん伸びる（既知の効果）
    const pts = makeWall({ yawDeg: 0, seed: 4 });
    const plane = fitWallPlane(pts);
    const camera = cameraFromPlane(plane, centroid(pts));

    const summary = frameScaleSummary(camera, plane, intrinsics, W, H);
    check('中央 < 端', summary.maxMMPerPx > summary.minMMPerPx,
      `${summary.minMMPerPx.toFixed(4)} 〜 ${summary.maxMMPerPx.toFixed(4)} mm/px`);
    check('正対なら画面内のばらつきは 15% 以内',
      summary.variation < 1.15, `比 ${summary.variation.toFixed(4)}`);
  }

  console.log('\n== 斜めに構えたとき ==');
  {
    // 壁を 40° 振る。正対比で 1/cos40° = 1.305 倍に伸びるはず（横方向のみ）
    const pts = makeWall({ yawDeg: 40, seed: 5 });
    const plane = fitWallPlane(pts);
    const camera = cameraFromPlane(plane, centroid(pts));

    const s = pixelScale(camera, plane, intrinsics, W / 2, H / 2);
    check('斜角 40° を検出', near(s.obliquityDeg, 40, 0.5), `${s.obliquityDeg.toFixed(2)}°`);

    const ratio = s.mmPerPxX / s.mmPerPxY;
    check('横だけが 1/cos40° に伸びる', near(ratio, 1 / Math.cos((40 * Math.PI) / 180), 0.01),
      `X/Y = ${ratio.toFixed(4)}（理論 ${(1 / Math.cos((40 * Math.PI) / 180)).toFixed(4)}）`);
    check('縦は正対と同じ', near(s.mmPerPxY, 1.5625, 0.01), `${s.mmPerPxY.toFixed(4)} mm/px`);

    const summary = frameScaleSummary(camera, plane, intrinsics, W, H);
    check('異方性が報告される', near(summary.anisotropy, 1 / Math.cos((40 * Math.PI) / 180), 0.01),
      `${summary.anisotropy.toFixed(4)}`);
    check('斜めだと画面内のばらつきが大きくなる',
      summary.variation > 1.3, `比 ${summary.variation.toFixed(3)}`);
  }

  console.log('\n== 斜角を無視した場合の誤差 ==');
  {
    // 「距離 × 焦点距離」だけで mm/px を出すと、斜めのぶんだけ系統的に外す。
    // その量が幾何どおりであることを確認しておく（帳票に書く根拠になる）
    for (const yaw of [10, 20, 30, 45]) {
      const pts = makeWall({ yawDeg: yaw, seed: 6 });
      const plane = fitWallPlane(pts);
      const camera = cameraFromPlane(plane, centroid(pts));
      const s = pixelScale(camera, plane, intrinsics, W / 2, H / 2);
      const naive = (s.distanceMM) / F;               // 斜めを無視した従来式
      const error = (s.mmPerPxX - naive) / naive;
      const theory = 1 / Math.cos((yaw * Math.PI) / 180) - 1;
      check(`斜角 ${yaw}° を無視すると ${(theory * 100).toFixed(1)}% 過小`,
        near(error, theory, 0.01), `実測 ${(error * 100).toFixed(1)}%`);
    }
  }

  console.log('\n== レイと平面 ==');
  {
    const pts = makeWall({ yawDeg: 0, seed: 7 });
    const plane = fitWallPlane(pts);
    const camera = cameraFromPlane(plane, centroid(pts));

    const centreRay = rayThroughPixel(camera, intrinsics, W / 2, H / 2);
    check('中央の画素は光軸', near(Math.abs(centreRay[0]), 1, 1e-4),
      `(${centreRay.map((v) => v.toFixed(4)).join(', ')})`);

    // 背後を向いたレイは交わらない
    const behind = intersectPlane(plane, camera.eye, [-1, 0, 0]);
    check('背後のレイは交点なし', behind === null);
    // 面に平行なレイも交わらない
    const parallel = intersectPlane(plane, camera.eye, [0, 0, 1]);
    check('平行なレイは交点なし', parallel === null);
  }

  console.log('\n== 剥落リスクの判定 ==');
  {
    const both = spallingRisk({ openingMM: 0.42, limitMM: 0.10 }, { bulgeMM: 22, noiseMM: 3 });
    check('開き＋はらみ出し → high', both.level === 'high', both.reason);

    const openOnly = spallingRisk({ openingMM: 0.42, limitMM: 0.10 }, { bulgeMM: 4, noiseMM: 3 });
    check('開きのみ → watch', openOnly.level === 'watch', openOnly.reason);

    const bulgeOnly = spallingRisk({ openingMM: 0.03, limitMM: 0.10 }, { bulgeMM: 22, noiseMM: 3 });
    check('はらみ出しのみ → watch', bulgeOnly.level === 'watch', bulgeOnly.reason);

    const quiet = spallingRisk({ openingMM: 0.03, limitMM: 0.10 }, { bulgeMM: 4, noiseMM: 3 });
    check('どちらも限界内 → low', quiet.level === 'low', quiet.reason);

    const nothing = spallingRisk({ openingMM: null, limitMM: null }, { bulgeMM: null, noiseMM: null });
    check('計測が無ければ unknown', nothing.level === 'unknown', nothing.reason);

    check('根拠の数値が必ず付く',
      both.evidence.openingMM === 0.42 && both.evidence.bulgeMM === 22);

    // 検出限界すれすれを「有意」にしない
    const marginal = spallingRisk({ openingMM: 0.10, limitMM: 0.10 }, { bulgeMM: 9, noiseMM: 3 });
    check('限界ちょうどは有意としない', marginal.level === 'low', marginal.reason);
  }
}
