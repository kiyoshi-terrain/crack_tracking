// 亀裂測点の検証。
//
// 画像は使わず、既知の変位を持つ点（セル）を線の両側に置いて、
// 開口・ずれ・標準誤差が正しく出るか、線の引き方に依存しないか、
// 除外すべき点が除外されるかを見る。

import {
  crackFrame, crackPatches, splitPoints, crackOpening, crackOpeningSeries, crackOpeningEpoch, lineToLocal,
} from '../src/crackline.js';

function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
/** 平均 0・σ=1 の正規乱数（Box–Muller） */
function gauss(rand) {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 格子点のセルを作る。側2（法線の正側）だけに既知の変位を足す。
 * @param {object} line
 * @param {{du:number, dv:number}} move 側2の変位
 * @param {number} noise セルごとのノイズ σ[px]
 */
function makeCells({ line, move, noise = 0, step = 40, size = 800, seed = 7, decorate = () => ({}) }) {
  const rand = makeRandom(seed);
  const f = crackFrame(line);
  const cells = [];
  for (let y = step; y < size; y += step) {
    for (let x = step; x < size; x += step) {
      const rx = x - f.ox;
      const ry = y - f.oy;
      const d = rx * f.n.x + ry * f.n.y;
      const side2 = d > 0;
      cells.push({
        x, y,
        du: (side2 ? move.du : 0) + noise * gauss(rand),
        dv: (side2 ? move.dv : 0) + noise * gauss(rand),
        ...decorate(x, y, side2),
      });
    }
  }
  return cells;
}

export function runCrackLineTests(check, near) {
  console.log('\n== 亀裂測点（crackline） ==');

  // ── 局所座標系の正規化
  {
    const down = crackFrame({ x1: 400, y1: 100, x2: 400, y2: 700 });
    const up = crackFrame({ x1: 400, y1: 700, x2: 400, y2: 100 });
    check('縦線の接線は下向きに揃う', near(down.t.y, 1, 1e-9) && near(up.t.y, 1, 1e-9));
    check('縦線の法線は右向き（右側が側2）', near(down.n.x, 1, 1e-9) && near(up.n.x, 1, 1e-9));
    check('縦線の起点は上端に揃う', down.oy === 100 && up.oy === 100);
    const right = crackFrame({ x1: 100, y1: 400, x2: 700, y2: 400 });
    const left = crackFrame({ x1: 700, y1: 400, x2: 100, y2: 400 });
    check('横線の接線は右向きに揃う', near(right.t.x, 1, 1e-9) && near(left.t.x, 1, 1e-9));
    check('横線の法線は上向き（上側が側2）', near(right.n.y, -1, 1e-9) && near(left.n.y, -1, 1e-9));
    check('向きの表示: 鉛直／水平／斜め',
      down.orientation === '鉛直' && right.orientation === '水平'
      && crackFrame({ x1: 0, y1: 0, x2: 100, y2: 100 }).orientation === '斜め');
    check('長さゼロの線は null', crackFrame({ x1: 5, y1: 5, x2: 5, y2: 5 }) === null);
  }

  // ── 鉛直亀裂: 右側が右へ 0.8px、下へ 0.5px 動いた
  {
    const line = { x1: 400, y1: 100, x2: 400, y2: 700 };
    const cells = makeCells({ line, move: { du: 0.8, dv: 0.5 } });
    const r = crackOpening(cells, line, { margin: 20, depth: 160 });
    check('鉛直亀裂: 開口 0.8 を復元', r.ok && near(r.openingPx, 0.8, 1e-9), r.ok ? `→ ${r.openingPx.toFixed(4)}` : r.reason);
    check('鉛直亀裂: ずれ +0.5（右側が下がる＝正）', r.ok && near(r.shearPx, 0.5, 1e-9), r.ok ? `→ ${r.shearPx.toFixed(4)}` : '');
    check('両側に測点がある', r.ok && r.n1 >= 4 && r.n2 >= 4, r.ok ? `側1 ${r.n1}・側2 ${r.n2}` : '');

    // 引く向きを逆にしても同じ値
    const rev = crackOpening(cells, { x1: 400, y1: 700, x2: 400, y2: 100 }, { margin: 20, depth: 160 });
    check('線を逆向きに引いても開口・ずれが同じ',
      rev.ok && near(rev.openingPx, r.openingPx, 1e-9) && near(rev.shearPx, r.shearPx, 1e-9));

    // 閉じる向き
    const close = makeCells({ line, move: { du: -0.3, dv: 0 } });
    const rc = crackOpening(close, line, { margin: 20, depth: 160 });
    check('右側が左へ動くと開口は負（閉じた）', rc.ok && near(rc.openingPx, -0.3, 1e-9));
  }

  // ── 水平亀裂: 下側が下へ 1.0px 動いた → 開口 +1.0
  {
    const line = { x1: 100, y1: 400, x2: 700, y2: 400 };
    // 側2 は上側（n = (0,-1)）。下側が動くので側1 に変位を与える: 上側を 0、下側を +1 とするには
    // makeCells の move を側2 に付ける仕様なので、全体を −1 ずらして等価にする
    const cells = makeCells({ line, move: { du: 0, dv: -1.0 } }); // 上側が上へ 1.0 ＝ 下側が下へ 1.0 と相対的に同じ
    const r = crackOpening(cells, line, { margin: 20, depth: 160 });
    check('水平亀裂: 上下が離れると開口は正', r.ok && near(r.openingPx, 1.0, 1e-9), r.ok ? `→ ${r.openingPx.toFixed(4)}` : r.reason);
    check('水平亀裂: 接線方向の食い違いが無ければずれは 0', r.ok && near(r.shearPx, 0, 1e-9));
  }

  // ── 斜め 45° の亀裂: 法線方向に動かすと開口だけに出る
  {
    const line = { x1: 150, y1: 150, x2: 650, y2: 650 };
    const f = crackFrame(line);
    const mag = 0.6;
    const cells = makeCells({ line, move: { du: mag * f.n.x, dv: mag * f.n.y } });
    const r = crackOpening(cells, line, { margin: 20, depth: 160 });
    check('斜め亀裂: 法線方向の変位は開口にだけ出る',
      r.ok && near(r.openingPx, mag, 1e-6) && near(r.shearPx, 0, 1e-6),
      r.ok ? `開口 ${r.openingPx.toFixed(4)} ずれ ${r.shearPx.toFixed(4)}` : r.reason);
    const cellsT = makeCells({ line, move: { du: mag * f.t.x, dv: mag * f.t.y } });
    const rt = crackOpening(cellsT, line, { margin: 20, depth: 160 });
    check('斜め亀裂: 接線方向の変位はずれにだけ出る',
      rt.ok && near(rt.openingPx, 0, 1e-6) && near(rt.shearPx, mag, 1e-6));
  }

  // ── 線をまたぐセルは margin で除外される
  {
    const line = { x1: 400, y1: 100, x2: 400, y2: 700 };
    // 線の真上（x=400）に、でたらめな変位のセルを置く。step=40 なので x=400 は格子点
    const cells = makeCells({ line, move: { du: 0.8, dv: 0 } })
      .map((c) => (c.x === 400 ? { ...c, du: 5, dv: -5 } : c));
    const r = crackOpening(cells, line, { margin: 20, depth: 160 });
    check('線をまたぐ測点（margin 未満）は使わない', r.ok && near(r.openingPx, 0.8, 1e-9),
      r.ok ? `→ ${r.openingPx.toFixed(4)}` : r.reason);
    const { side1, side2 } = splitPoints(cells, line, { margin: 20, depth: 160 });
    check('分けた点はすべて margin より外', [...side1, ...side2].every((c) => Math.abs(c.x - 400) >= 20));
    check('線分の範囲外（s が外）の点は使わない', [...side1, ...side2].every((c) => c.y >= 100 && c.y <= 700));
  }

  // ── 相関低下・影・欠測のセルは使わない
  {
    const line = { x1: 400, y1: 100, x2: 400, y2: 700 };
    const cells = makeCells({
      line, move: { du: 0.8, dv: 0 },
      decorate: (x, y, side2) => {
        if (side2 && y === 240) return { du: 9, dv: 9, decorrelated: true };
        if (side2 && y === 280) return { du: 9, dv: 9, illuminationChanged: true };
        if (!side2 && y === 320) return { du: null, dv: null };
        return {};
      },
    });
    const r = crackOpeningEpoch(cells, line, { margin: 20, depth: 160 });
    check('相関低下・影・欠測のセルを除いても開口 0.8', r.ok && near(r.openingPx, 0.8, 1e-9),
      r.ok ? `→ ${r.openingPx.toFixed(4)}` : r.reason);
    check('除外した数を報告する', r.ok && r.excluded.decorrelated === 4 && r.excluded.illumination === 4 && r.excluded.missing === 4,
      r.ok ? JSON.stringify(r.excluded) : '');
  }

  // ── 片側に点が無ければ断る（黙らない）
  {
    const line = { x1: 40, y1: 100, x2: 40, y2: 700 }; // 画像の左端。左側（側1）に点が無い
    const cells = makeCells({ line, move: { du: 0.8, dv: 0 } });
    const r = crackOpening(cells, line, { margin: 20, depth: 160 });
    check('片側に測点が無ければ ok=false と理由', !r.ok && /足りません/.test(r.reason), r.reason);
  }

  // ── 標準誤差: ノイズ σ=0.05 のセルで、se ≈ hypot(σ/√n1, σ/√n2, 床)。床より下がらない
  {
    const line = { x1: 400, y1: 100, x2: 400, y2: 700 };
    const noise = 0.05;
    const cells = makeCells({ line, move: { du: 0.8, dv: 0 }, noise, seed: 11 });
    const r = crackOpeningEpoch(cells, line, { margin: 20, depth: 160, systematicFloorPx: 0.02 });
    const expected = Math.hypot(noise / Math.sqrt(r.n1), noise / Math.sqrt(r.n2), 0.02);
    check('開口はノイズの中で真値を復元', r.ok && Math.abs(r.openingPx - 0.8) < 3 * r.sePx,
      r.ok ? `→ ${r.openingPx.toFixed(4)} ± ${r.sePx.toFixed(4)}` : r.reason);
    check('標準誤差はノイズ/√n と床の合成に近い', r.ok && r.sePx > expected * 0.6 && r.sePx < expected * 1.6,
      r.ok ? `se ${r.sePx.toFixed(4)}（目安 ${expected.toFixed(4)}）` : '');
    const quiet = makeCells({ line, move: { du: 0, dv: 0 }, noise: 0 });
    const rq = crackOpeningEpoch(quiet, line, { margin: 20, depth: 160, systematicFloorPx: 0.02 });
    check('ノイズが無くても標準誤差は床より下がらない', rq.ok && near(rq.sePx, 0.02, 1e-9), rq.ok ? `se ${rq.sePx.toFixed(4)}` : '');
    // 視差補正の標準誤差が乗る
    const withPx = quiet.map((c) => ({ ...c, parallaxSePx: 0.03 }));
    const rp = crackOpeningEpoch(withPx, line, { margin: 20, depth: 160, systematicFloorPx: 0.02 });
    check('視差補正の標準誤差が乗る', rp.ok && near(rp.sePx, Math.hypot(0.02, 0.03), 1e-9));
  }

  // ── フレーム系列（σ 実測）: 動いていない壁の連写。平均 ≈ 0、σ はノイズ相応
  {
    const line = { x1: 400, y1: 100, x2: 400, y2: 700 };
    const noise = 0.03;
    const frames = [];
    for (let i = 0; i < 12; i += 1) {
      frames.push(makeCells({ line, move: { du: 0, dv: 0 }, noise, step: 25, seed: 100 + i }));
    }
    const s = crackOpeningSeries(frames, line, { margin: 20, depth: 100 });
    check('連写の系列: 12 フレームぶん出る', s.ok && s.frames === 12, s.ok ? `${s.frames} 枚` : s.reason);
    check('動いていなければ開口の平均 ≈ 0', s.ok && Math.abs(s.openingPx) < 3 * s.sigmaOpeningPx / Math.sqrt(12),
      s.ok ? `→ ${s.openingPx.toFixed(4)}（σ ${s.sigmaOpeningPx.toFixed(4)}）` : '');
    // 片側 ~4×27 点の中央値の差なので、1 フレームの σ は noise × √(2·π/2 / n) 程度。桁が合っていればよい
    check('σ はノイズより小さく、ゼロではない', s.ok && s.sigmaOpeningPx > 0 && s.sigmaOpeningPx < noise,
      s.ok ? `σ ${s.sigmaOpeningPx.toFixed(4)} px（点ノイズ ${noise}）` : '');
    // 1 フレームだけ相関が取れなかった想定 — そのフレームは飛ばして続ける
    const broken = [...frames, []];
    const sb = crackOpeningSeries(broken, line, { margin: 20, depth: 100 });
    check('点の無いフレームは飛ばす', sb.ok && sb.frames === 12);
    check('有効フレームが 2 枚未満なら断る', !crackOpeningSeries([frames[0]], line).ok);
  }

  // ── ROI 座標系への変換と、描画用パッチ
  {
    const line = { x1: 400, y1: 100, x2: 400, y2: 700 };
    const local = lineToLocal(line, { x: 100, y: 50, width: 600, height: 700 });
    check('ROI 座標への変換', local.x1 === 300 && local.y1 === 50 && local.x2 === 300 && local.y2 === 650);
    const p = crackPatches(line, { margin: 20, depth: 100 });
    const xs2 = p.side2.map((c) => c[0]);
    const xs1 = p.side1.map((c) => c[0]);
    check('描画用パッチ: 側2 は線の右、側1 は左',
      Math.min(...xs2) >= 420 - 1e-9 && Math.max(...xs2) <= 520 + 1e-9
      && Math.max(...xs1) <= 380 + 1e-9 && Math.min(...xs1) >= 280 - 1e-9);
  }
}
