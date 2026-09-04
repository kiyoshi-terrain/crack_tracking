// 亀裂測点 — 亀裂をまたぐ2つのパッチの相対変位。
//
// ターゲット方式では「き裂を挟む2点の距離」を測点の量にできるが、
// 非接触の DIC では変位の「場」しか出ない。場から数字を 1 つ取り出す
// 経路が無いと、特定の亀裂を経時管理に載せられない。これはその経路。
//
// 使い方: 基準画像の上で亀裂に沿って線分を引く。線の両側に、線から
// margin だけ離した帯（パッチ）を取り、各パッチの変位の代表値の差を
//
//   開口 = (側2 − 側1)・n   … 法線成分。正なら開いた
//   ずれ = (側2 − 側1)・t   … 接線成分。亀裂に沿った食い違い
//
// で出す。margin を取るのは、亀裂をまたぐサブセットの変位が両側の中間値に
// なって（半分ずつ引っ張られる）どちらの側の量でもなくなるため。
//
// 符号を線の引き方に依存させない: 接線 t は必ず下向き（縦線）または
// 右向き（横線）に正規化し、法線 n = (t.y, −t.x) で右側（縦線なら右、
// 横線なら上）を側2とする。P1→P2 で引いても P2→P1 で引いても同じ値になる。
//
// 入力は座標と変位を持つ点の配列 [{x, y, du, dv}] だけ。σ 実測の残差点でも、
// 2時期比較のセルでも同じ関数が使える。画像は要らないので合成で検証できる。

import { median, robustSigma } from './sigma.js';

/** @typedef {{x1:number, y1:number, x2:number, y2:number, label?:string}} CrackLine */

export const defaultOptions = {
  /** 線からパッチの内縁までの距離[px]。サブセット半径 + 数 px が目安 */
  margin: 20,
  /** パッチの奥行き[px]（線から離れる方向）。測点間隔の 3〜4 倍が目安 */
  depth: 100,
  /** 片側に最低いくつ点が要るか */
  minPoints: 4,
  /** 系統誤差の床[px]。change.js と同じ根拠（補間バイアスはばらつきに出ない） */
  systematicFloorPx: 0.02,
};

/**
 * 線分の局所座標系。接線 t は下向き（縦線）または右向き（横線）に正規化する。
 * @param {CrackLine} line
 */
export function crackFrame(line) {
  let tx = line.x2 - line.x1;
  let ty = line.y2 - line.y1;
  const length = Math.hypot(tx, ty);
  if (!(length > 0)) return null;
  tx /= length;
  ty /= length;
  // 正規化: |ty| が支配的なら下向き、そうでなければ右向きに揃える
  const flip = Math.abs(ty) >= Math.abs(tx) ? ty < 0 : tx < 0;
  if (flip) { tx = -tx; ty = -ty; }
  // 起点は「正規化した t の向きで手前に来る端」に置く。これで s∈[0, L] が
  // 引いた向きに依存しない
  const startAtP1 = (line.x2 - line.x1) * tx + (line.y2 - line.y1) * ty >= 0;
  const ox = startAtP1 ? line.x1 : line.x2;
  const oy = startAtP1 ? line.y1 : line.y2;
  return {
    ox, oy, length,
    t: { x: tx, y: ty },
    n: { x: ty, y: -tx },
    /** 表示用: 鉛直／水平／斜め */
    orientation: Math.abs(tx) < 0.3 ? '鉛直' : Math.abs(ty) < 0.3 ? '水平' : '斜め',
  };
}

/**
 * 点を線の局所座標 (s: 接線方向, d: 法線方向) に写す。
 */
function project(frame, x, y) {
  const rx = x - frame.ox;
  const ry = y - frame.oy;
  return { s: rx * frame.t.x + ry * frame.t.y, d: rx * frame.n.x + ry * frame.n.y };
}

/**
 * 両側のパッチの四隅（画像座標）。描画用。
 * @returns {{side1:number[][], side2:number[][], frame:object}|null}
 */
export function crackPatches(line, userOptions = {}) {
  const o = { ...defaultOptions, ...userOptions };
  const f = crackFrame(line);
  if (!f) return null;
  const corner = (s, d) => [f.ox + s * f.t.x + d * f.n.x, f.oy + s * f.t.y + d * f.n.y];
  const rect = (d0, d1) => [corner(0, d0), corner(f.length, d0), corner(f.length, d1), corner(0, d1)];
  return {
    frame: f,
    side1: rect(-o.margin - o.depth, -o.margin),
    side2: rect(o.margin, o.margin + o.depth),
  };
}

/**
 * 点を線の両側に振り分ける。margin 未満（線をまたぐサブセット）と
 * depth 超（遠すぎる）と、線分の範囲外（s が [0, L] の外）は捨てる。
 */
export function splitPoints(points, line, userOptions = {}) {
  const o = { ...defaultOptions, ...userOptions };
  const f = crackFrame(line);
  const side1 = [];
  const side2 = [];
  if (!f) return { side1, side2, frame: null };
  for (const p of points) {
    const { s, d } = project(f, p.x, p.y);
    if (s < 0 || s > f.length) continue;
    const a = Math.abs(d);
    if (a < o.margin || a > o.margin + o.depth) continue;
    (d > 0 ? side2 : side1).push(p);
  }
  return { side1, side2, frame: f };
}

/** 変位が読めていて、判定から外すべき印の無い点か */
export function usablePoint(p) {
  return p != null
    && Number.isFinite(p.du) && Number.isFinite(p.dv)
    && !p.decorrelated && !p.illuminationChanged;
}

/**
 * 1 組（基準 vs 1 フレーム、または 2 時期の平均）の点から開口とずれを出す。
 * 代表値は中央値。パッチに外れ値（相関を誤った点）が 1 つ入っても動じない。
 *
 * @param {Array<{x:number,y:number,du:number,dv:number}>} points
 * @param {CrackLine} line
 * @returns {{ok:boolean, openingPx?:number, shearPx?:number, n1?:number, n2?:number,
 *            spread1Px?:number, spread2Px?:number, frame?:object, reason?:string}}
 */
export function crackOpening(points, line, userOptions = {}) {
  const o = { ...defaultOptions, ...userOptions };
  const { side1, side2, frame } = splitPoints(points.filter(usablePoint), line, o);
  if (!frame) return { ok: false, reason: '線分の長さがありません' };
  if (side1.length < o.minPoints || side2.length < o.minPoints) {
    return {
      ok: false, frame, n1: side1.length, n2: side2.length,
      reason: `亀裂の片側に測点が足りません（側1 ${side1.length}・側2 ${side2.length}、最低 ${o.minPoints}）。`
        + '線を長くするか、パッチの奥行きを広げてください',
    };
  }
  const nn = (ps) => ps.map((p) => p.du * frame.n.x + p.dv * frame.n.y);
  const tt = (ps) => ps.map((p) => p.du * frame.t.x + p.dv * frame.t.y);
  const n1 = nn(side1);
  const n2 = nn(side2);
  const t1 = tt(side1);
  const t2 = tt(side2);
  return {
    ok: true,
    frame,
    n1: side1.length,
    n2: side2.length,
    openingPx: median(n2) - median(n1),
    shearPx: median(t2) - median(t1),
    // 側ごとの点の散らばり（法線成分）。標準誤差の材料
    spread1Px: robustSigma(n1),
    spread2Px: robustSigma(n2),
    spreadShear1Px: robustSigma(t1),
    spreadShear2Px: robustSigma(t2),
  };
}

/**
 * σ 実測（同日の連写）用。フレームごとの残差点から開口の系列を作り、
 * その平均とばらつきを返す。構造物は数分では動かないので、ばらつきが
 * そのまま「この構図でこの亀裂の開口をどこまで読めるか」になる。
 *
 * 返す sigma は 1 フレームあたりのばらつき（ターゲット対の sigmaPx と同じ意味）。
 *
 * @param {Array<Array<{x:number,y:number,du:number,dv:number}>>} frames
 */
export function crackOpeningSeries(frames, line, userOptions = {}) {
  const perFrame = [];
  let lastReason = null;
  let frameInfo = null;
  for (const points of frames) {
    const r = crackOpening(points, line, userOptions);
    if (!r.ok) { lastReason = r.reason; continue; }
    frameInfo = r.frame;
    perFrame.push({ openingPx: r.openingPx, shearPx: r.shearPx, n1: r.n1, n2: r.n2 });
  }
  if (perFrame.length < 2) {
    return { ok: false, frames: perFrame.length, reason: lastReason ?? '有効なフレームが 2 枚未満です' };
  }
  const op = perFrame.map((p) => p.openingPx);
  const sh = perFrame.map((p) => p.shearPx);
  return {
    ok: true,
    frame: frameInfo,
    frames: perFrame.length,
    openingPx: op.reduce((s, v) => s + v, 0) / op.length,
    shearPx: sh.reduce((s, v) => s + v, 0) / sh.length,
    sigmaOpeningPx: robustSigma(op),
    sigmaShearPx: robustSigma(sh),
    perFrame,
  };
}

/**
 * 2 時期比較（change.js の cells）用。開口・ずれと、その標準誤差を返す。
 *
 * 標準誤差の組み立て:
 *   - 側ごとの点の散らばり / √n を 2 側で合成（ランダム成分。基準画像自身の
 *     ノイズもセルごとにランダムなので、実測の散らばりに含まれている）
 *   - 系統誤差の床を 1 回だけ足す（n で割らない。補間バイアスは全セル共通で
 *     ばらつきに出ないため）
 *   - 視差補正の標準誤差があれば、その平均を足す
 *
 * 相関低下・影の移動と判定されたセルは使わない。使わなかった数も返す。
 */
export function crackOpeningEpoch(cells, line, userOptions = {}) {
  const o = { ...defaultOptions, ...userOptions };
  const { side1: raw1, side2: raw2, frame } = splitPoints(cells, line, o);
  if (!frame) return { ok: false, reason: '線分の長さがありません' };
  const excluded = {
    decorrelated: [...raw1, ...raw2].filter((c) => c.decorrelated).length,
    illumination: [...raw1, ...raw2].filter((c) => c.illuminationChanged && !c.decorrelated).length,
    missing: [...raw1, ...raw2].filter((c) => c.du == null && !c.decorrelated && !c.illuminationChanged).length,
  };
  const r = crackOpening(cells, line, o);
  if (!r.ok) return { ...r, excluded };

  const random = Math.hypot(r.spread1Px / Math.sqrt(r.n1), r.spread2Px / Math.sqrt(r.n2));
  const randomShear = Math.hypot(r.spreadShear1Px / Math.sqrt(r.n1), r.spreadShear2Px / Math.sqrt(r.n2));
  const usable = [...raw1, ...raw2].filter(usablePoint);
  const parallax = usable.map((c) => c.parallaxSePx).filter((v) => Number.isFinite(v));
  const parallaxSe = parallax.length ? parallax.reduce((s, v) => s + v, 0) / parallax.length : 0;
  const se = Math.hypot(random, o.systematicFloorPx, parallaxSe);
  const seShear = Math.hypot(randomShear, o.systematicFloorPx, parallaxSe);

  return {
    ok: true,
    frame,
    openingPx: r.openingPx,
    shearPx: r.shearPx,
    sePx: se,
    seShearPx: seShear,
    n1: r.n1,
    n2: r.n2,
    parallaxSePx: parallaxSe,
    excluded,
  };
}

/**
 * 解析範囲が切り出された座標系（σ 実測の残差点は ROI 内の座標）へ線を移す。
 */
export function lineToLocal(line, roi) {
  if (!roi) return line;
  return { ...line, x1: line.x1 - roi.x, y1: line.y1 - roi.y, x2: line.x2 - roi.x, y2: line.y2 - roi.y };
}
