/**
 * 点群の2時期差分（面外）。
 *
 * 写真の比較モードが面内（き裂の開き・進展）を 0.03mm 級で見るのに対し、
 * こちらは**面外**（ブロックの浮き・はらみ出しの進行）を 5mm 級で見ます。
 * 剥落の直前に出るのは面外の浮きなので、監視の最終段はここが受け持ちます。
 *
 * ## 位置合わせの考え方
 *
 * 2回のスキャンは座標系が別物ですが、汎用の 3D-ICP はやりません。
 *
 * 1. 各時期で独立に壁面の平面を当てる（`fitWallPlane`）。壁は物理的に同じ面なので、
 *    平面に投影した高さマップ同士なら残る自由度は面内の並進＋微小回転だけ
 * 2. 面内の基底は「上」（重力）を種に作る。ARKit 系の点群は重力整列なので、
 *    ヘディングが違っても2時期のマップの向きは揃う
 * 3. 残った並進＋微小回転は、高さマップ同士の ZNCC 探索で合わせる。
 *    大谷石の目地の凹みがそのまま位置合わせの模様になる。
 *    模様が無い（平坦すぎる）場合は重心合わせに落とすが、平坦なら
 *    位置ずれは面外差分にほとんど効かないので、それで足りる
 *
 * ## 差分の約束（写真の比較モードと同じ）
 *
 * - 平面フィットの傾き・オフセットの差は、差分マップにちょうど平面として乗る。
 *   これを安定セル（＝多数派）へのロバスト平面フィットで除去する。
 *   刈るときは残差の中央値中心から（大きさの MAD ではなく）
 * - 限界は「セル自身のノイズ」と「差分マップの実測ばらつき」の大きい方に
 *   系統床を足したもの。塗られたものは全部有意
 *
 * 入出力は数値だけ。合成点群で回帰テストできる。
 */

import { fitWallPlane, signedDistance, planeBasis } from './pointcloud.js';

// ---------------------------------------------------------------- 投影と集計

/**
 * 点群を平面座標 (u, v) と面外距離 d に投影する。
 * up は重力の向き（点群の座標系で）。2時期で同じものを渡すこと。
 */
export function projectToPlane(points, plane, up) {
  const { e1, e2 } = planeBasis(plane.normal, up);
  const n = points.length / 3;
  const us = new Float64Array(n);
  const vs = new Float64Array(n);
  const ds = new Float64Array(n);
  let cu = 0;
  let cv = 0;
  for (let i = 0, p = 0; i < n; i += 1, p += 3) {
    const x = points[p];
    const y = points[p + 1];
    const z = points[p + 2];
    const u = x * e1[0] + y * e1[1] + z * e1[2];
    const v = x * e2[0] + y * e2[1] + z * e2[2];
    us[i] = u;
    vs[i] = v;
    ds[i] = signedDistance(plane, x, y, z);
    cu += u;
    cv += v;
  }
  return { us, vs, ds, e1, e2, count: n, centroidU: cu / n, centroidV: cv / n };
}

/**
 * 投影済みの点をセルに集計する。代表値は中央値、ばらつきは MAD。
 * 面外マップ（cloudpanel）と違い、σ算出のためにセルごとの MAD と点数も持つ。
 *
 * du/dv/thetaDeg を渡すと、集計前に (u,v) を回転中心 (cu,cv) まわりに回して
 * 平行移動する。B側を A の格子に載せ替えるための引数で、A側では使わない。
 */
export function binHeightMap(proj, grid, { du = 0, dv = 0, thetaDeg = 0, cu = 0, cv = 0 } = {}) {
  const { originU, originV, cellSize, cols, rows } = grid;
  const buckets = new Array(cols * rows);
  const th = (thetaDeg * Math.PI) / 180;
  const cos = Math.cos(th);
  const sin = Math.sin(th);

  for (let i = 0; i < proj.count; i += 1) {
    let u = proj.us[i];
    let v = proj.vs[i];
    if (thetaDeg !== 0) {
      const ru = cu + (u - cu) * cos - (v - cv) * sin;
      const rv = cv + (u - cu) * sin + (v - cv) * cos;
      u = ru;
      v = rv;
    }
    u += du;
    v += dv;
    const cx = Math.floor((u - originU) / cellSize);
    const cy = Math.floor((v - originV) / cellSize);
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
    const idx = cy * cols + cx;
    (buckets[idx] || (buckets[idx] = [])).push(proj.ds[i]);
  }

  const values = new Float64Array(cols * rows).fill(NaN);
  const mads = new Float64Array(cols * rows).fill(NaN);
  const counts = new Int32Array(cols * rows);
  for (let i = 0; i < buckets.length; i += 1) {
    const b = buckets[i];
    if (!b) continue;
    counts[i] = b.length;
    const m = median(b);
    values[i] = m;
    mads[i] = median(b.map((d) => Math.abs(d - m)));
  }
  return { values, mads, counts };
}

function median(values) {
  if (!values.length) return 0;
  const a = Float64Array.from(values).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// ---------------------------------------------------------------- 位置合わせ

/** 整数セルずらし (di, dj) での2マップの ZNCC。B は A の格子に載っている前提。 */
function shiftedZncc(a, b, cols, rows, di, dj, minPoints) {
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let r = 0; r < rows; r += 1) {
    const rb = r + dj;
    if (rb < 0 || rb >= rows) continue;
    for (let c = 0; c < cols; c += 1) {
      const cb = c + di;
      if (cb < 0 || cb >= cols) continue;
      const va = a.values[r * cols + c];
      const vb = b.values[rb * cols + cb];
      if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
      if (a.counts[r * cols + c] < minPoints || b.counts[rb * cols + cb] < minPoints) continue;
      n += 1;
      sa += va; sb += vb;
      saa += va * va; sbb += vb * vb; sab += va * vb;
    }
  }
  if (n < 8) return { zncc: -2, n };
  const ma = sa / n;
  const mb = sb / n;
  const varA = saa / n - ma * ma;
  const varB = sbb / n - mb * mb;
  if (varA <= 1e-18 || varB <= 1e-18) return { zncc: -2, n };
  return { zncc: (sab / n - ma * mb) / Math.sqrt(varA * varB), n };
}

/**
 * B のマップを回転候補ごとに作り直しながら、A に最も重なる回転＋並進を探す。
 * 戻り値の shift はセル単位（サブセル精度、B→A の向き）。
 */
export function registerHeightMaps(projB, mapA, grid, options = {}) {
  const {
    baseDu = 0, baseDv = 0,
    searchCells = 12,
    rotationsDeg = [-2, -1, -0.5, 0, 0.5, 1, 2],
    minPointsPerCell = 3,
    minZncc = 0.35,
  } = options;
  const { cols, rows } = grid;
  const base = { du: baseDu, dv: baseDv, cu: projB.centroidU + baseDu, cv: projB.centroidV + baseDv };

  // 目地は周期パターンなので、1周期（石1〜2個ぶん）ずれた場所でも相関は同点になる。
  // 重心合わせを事前情報として、ずれが大きいほど相関から差し引く。
  // 同点なら小さいずれが勝ち、模様に本当の根拠があれば周期ぶんの差は残る
  const prior = (di, dj) => 0.08 * Math.hypot(di, dj) / Math.max(1, searchCells);

  // 粗探索: 回転ごとにマップを作り直し、2セル刻みでずらして相関を取る
  let best = { score: -2, zncc: -2, thetaDeg: 0, di: 0, dj: 0, map: null };
  for (const thetaDeg of rotationsDeg) {
    const mapB = binHeightMap(projB, grid, { ...base, thetaDeg });
    for (let dj = -searchCells; dj <= searchCells; dj += 2) {
      for (let di = -searchCells; di <= searchCells; di += 2) {
        const { zncc } = shiftedZncc(mapA, mapB, cols, rows, di, dj, minPointsPerCell);
        const score = zncc - prior(di, dj);
        if (score > best.score) best = { score, zncc, thetaDeg, di, dj, map: mapB };
      }
    }
  }

  if (best.zncc < minZncc) {
    // 模様が無い（平坦・雪面など）。平坦なら位置ずれは面外差分に効かないので
    // 重心合わせのまま進める。ただしその旨を返して UI に出させる
    return {
      mode: 'centroid', thetaDeg: 0, di: 0, dj: 0, sx: 0, sy: 0,
      zncc: best.zncc,
      map: binHeightMap(projB, grid, base),
    };
  }

  // 精探索: 最良回転のまわりを1セル刻み
  const mapB = best.map;
  for (let dj = best.dj - 2; dj <= best.dj + 2; dj += 1) {
    for (let di = best.di - 2; di <= best.di + 2; di += 1) {
      const { zncc } = shiftedZncc(mapA, mapB, cols, rows, di, dj, minPointsPerCell);
      const score = zncc - prior(di, dj);
      if (score > best.score) best = { ...best, score, zncc, di, dj };
    }
  }

  // サブセル: 相関のピークを軸ごとに放物線で内挿
  const at = (di, dj) => shiftedZncc(mapA, mapB, cols, rows, di, dj, minPointsPerCell).zncc;
  const sx = best.di + parabolicPeak(at(best.di - 1, best.dj), best.zncc, at(best.di + 1, best.dj));
  const sy = best.dj + parabolicPeak(at(best.di, best.dj - 1), best.zncc, at(best.di, best.dj + 1));

  return { mode: 'zncc', thetaDeg: best.thetaDeg, di: best.di, dj: best.dj, sx, sy, zncc: best.zncc, map: mapB };
}

function parabolicPeak(left, centre, right) {
  if (!(left > -1.5) || !(right > -1.5)) return 0;
  const denom = left - 2 * centre + right;
  if (Math.abs(denom) < 1e-12) return 0;
  const d = 0.5 * (left - right) / denom;
  return Math.max(-0.5, Math.min(0.5, d));
}

/** B マップをサブセル位置でバイリニア補間。欠損は重みを配り直し、過半が欠けたら NaN。 */
function sampleMap(map, cols, rows, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let wsum = 0;
  let vsum = 0;
  let msum = 0;
  let csum = 0;
  for (let jy = 0; jy <= 1; jy += 1) {
    for (let jx = 0; jx <= 1; jx += 1) {
      const cx = x0 + jx;
      const cy = y0 + jy;
      if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
      const idx = cy * cols + cx;
      const v = map.values[idx];
      if (!Number.isFinite(v)) continue;
      const w = (jx ? fx : 1 - fx) * (jy ? fy : 1 - fy);
      wsum += w;
      vsum += w * v;
      msum += w * map.mads[idx];
      csum += w * map.counts[idx];
    }
  }
  if (wsum < 0.5) return null;
  return { value: vsum / wsum, mad: msum / wsum, count: csum / wsum };
}

// ---------------------------------------------------------------- 本体

/**
 * 2時期の点群を比べて、面外の有意な変化だけを抽出する。
 *
 * 前提: 両時期とも**壁の同じ側**からスキャンしていること（法線は視点側を向く）。
 * 単位は2つの点群で揃えて渡すこと。
 *
 * @param {Float64Array} pointsA 基準時期
 * @param {Float64Array} pointsB 今回
 * @param {object} options
 *   cellSize        セル一辺（点群と同じ単位）。必須
 *   up              重力の向き。既定 [0,0,1]（LAS）。ARKit 系 PLY は [0,1,0]
 *   minPointsPerCell セルの最少点数（既定 3）
 *   k               有意判定の倍率（既定 3）
 *   floor           系統床（同単位）。位置合わせの残差など、ばらつきに出ない誤差のぶん
 *   searchCells     位置合わせの並進探索半径（セル）
 *   rotationsDeg    位置合わせの回転候補
 *   stableRegion    (u,v)=>bool。動くと疑う領域を補正から外すとき
 */
export function compareEpochClouds(pointsA, pointsB, options = {}) {
  const {
    cellSize,
    up = [0, 0, 1],
    minPointsPerCell = 3,
    k = 3,
    floor = 0,
    searchCells = 12,
    rotationsDeg = [-2, -1, -0.5, 0, 0.5, 1, 2],
    minRegistrationZncc = 0.35,
    edgeFactor = 0.6,
    stableRegion = null,
    maxCells = 500000,
  } = options;
  if (!(cellSize > 0)) throw new Error('cellSize を指定してください');

  const planeA = fitWallPlane(pointsA);
  const planeB = fitWallPlane(pointsB);

  const projA = projectToPlane(pointsA, planeA, up);
  const projB = projectToPlane(pointsB, planeB, up);

  // 格子は A の広がりから決める（差分は A 系で語る）
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < projA.count; i += 1) {
    const u = projA.us[i];
    const v = projA.vs[i];
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const cols = Math.max(1, Math.ceil((maxU - minU) / cellSize));
  const rows = Math.max(1, Math.ceil((maxV - minV) / cellSize));
  if (cols * rows > maxCells) {
    throw new Error(`セルが多すぎます（${cols}×${rows}）。セルを大きくしてください`);
  }
  const grid = { originU: minU, originV: minV, cellSize, cols, rows };

  const mapA = binHeightMap(projA, grid);

  // 重心合わせを探索の中心にして、そこから並進±回転を詰める
  const registration = registerHeightMaps(projB, mapA, grid, {
    baseDu: projA.centroidU - projB.centroidU,
    baseDv: projA.centroidV - projB.centroidV,
    searchCells,
    rotationsDeg,
    minPointsPerCell,
    minZncc: minRegistrationZncc,
  });
  const mapB = registration.map;

  // 差分（生）: dz > 0 = 今回のほうが視点側 = 浮き・はらみ出しの進行
  const dzRaw = new Float64Array(cols * rows).fill(NaN);
  const noise = new Float64Array(cols * rows).fill(NaN);
  let missing = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      if (!Number.isFinite(mapA.values[idx]) || mapA.counts[idx] < minPointsPerCell) continue;
      const b = sampleMap(mapB, cols, rows, c + registration.sx, r + registration.sy);
      if (!b || b.count < minPointsPerCell) {
        missing += 1;
        continue;
      }
      dzRaw[idx] = b.value - mapA.values[idx];
      // 中央値の標準誤差 ≈ 1.2533 σ/√n、σ ≈ 1.4826 MAD
      const sa = (1.4826 * mapA.mads[idx]) ** 2 / mapA.counts[idx];
      const sb = (1.4826 * b.mad) ** 2 / b.count;
      noise[idx] = 1.2533 * Math.sqrt(sa + sb);
    }
  }

  // 平面フィットの傾き・オフセット差を除去。刈りは残差の中央値中心から
  const correction = fitCorrectionPlane(dzRaw, grid, stableRegion);
  const dz = new Float64Array(cols * rows).fill(NaN);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      if (!Number.isFinite(dzRaw[idx])) continue;
      const u = grid.originU + (c + 0.5) * cellSize;
      const v = grid.originV + (r + 0.5) * cellSize;
      dz[idx] = dzRaw[idx] - (correction.a * u + correction.b * v + correction.c);
    }
  }

  // 段差（目地・稜線）をまたぐセルは、位置合わせの残差とサンプリングの偏りで
  // 中央値が段差のどちら側に落ちるかが時期間で反転しうる。その振れ幅は
  // 「近傍セルとの高低差」の程度なので、そのぶん限界を正直に広げる。
  // 平坦なセルには効かず、目地の上だけ判定が慎重になる
  const edgeRange = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      let m = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dx;
        const nr = r + dy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const nb = nr * cols + nc;
        if (Number.isFinite(mapA.values[idx]) && Number.isFinite(mapA.values[nb])) {
          m = Math.max(m, Math.abs(mapA.values[nb] - mapA.values[idx]));
        }
        // B は位置合わせのずれ (sx, sy) ぶん動かして読む。差分と同じ場所を見ないと、
        // ずれが数セルあるとき段差の判定が隣のセルの値で決まる。
        // 段差の大きさは補間せず生のセル値で取る（双一次で読むと目地と石の間で
        // 段差がなまり、限界が足りずに目地のセルが有意になる）
        const bc = Math.round(c + registration.sx);
        const br = Math.round(r + registration.sy);
        const bnc = bc + dx;
        const bnr = br + dy;
        if (bc >= 0 && bc < cols && br >= 0 && br < rows
          && bnc >= 0 && bnc < cols && bnr >= 0 && bnr < rows) {
          const bv = mapB.values[br * cols + bc];
          const bw = mapB.values[bnr * cols + bnc];
          if (Number.isFinite(bv) && Number.isFinite(bw)) m = Math.max(m, Math.abs(bw - bv));
        }
      }
      edgeRange[idx] = m;
    }
  }

  // 限界: セル自身のノイズと、補正後マップの実測ばらつきの大きい方 ＋ 系統床 ＋ 段差ぶん
  const sigmaEmp = correction.sigma;
  const limit = new Float64Array(cols * rows).fill(NaN);
  const significant = new Uint8Array(cols * rows);
  let evaluated = 0;
  let signifCount = 0;
  let maxAbs = 0;
  for (let i = 0; i < dz.length; i += 1) {
    if (!Number.isFinite(dz[i])) continue;
    evaluated += 1;
    const s = Math.max(sigmaEmp, noise[i]);
    limit[i] = k * Math.sqrt(s * s + floor * floor) + edgeFactor * edgeRange[i];
    if (Math.abs(dz[i]) > maxAbs) maxAbs = Math.abs(dz[i]);
    if (Math.abs(dz[i]) > limit[i]) {
      significant[i] = 1;
      signifCount += 1;
    }
  }

  return {
    ok: evaluated > 0,
    grid,
    e1: projA.e1,
    e2: projA.e2,
    planeA: summary(planeA),
    planeB: summary(planeB),
    registration: {
      mode: registration.mode,
      thetaDeg: registration.thetaDeg,
      zncc: registration.zncc,
      shiftU: registration.sx * cellSize,
      shiftV: registration.sy * cellSize,
    },
    correction: { a: correction.a, b: correction.b, c: correction.c, inlierCells: correction.inliers },
    dz,
    limit,
    noise,
    significant,
    countA: mapA.counts,
    sigmaEmp,
    k,
    floor,
    stats: { evaluated, significant: signifCount, missing, maxAbs },
  };
}

function summary(plane) {
  return {
    rms: plane.rms,
    viewpointDistance: plane.viewpointDistance,
    inlierRatio: plane.inlierRatio,
    normal: plane.normal,
  };
}

/**
 * 差分マップに乗った平面成分（2つの平面フィットの傾き・オフセット差）を
 * ロバストに推定する。浮きの領域は少数派の外れ値として刈られる。
 */
function fitCorrectionPlane(dzRaw, grid, stableRegion) {
  const { cols, rows, cellSize, originU, originV } = grid;
  const cells = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      if (!Number.isFinite(dzRaw[idx])) continue;
      const u = originU + (c + 0.5) * cellSize;
      const v = originV + (r + 0.5) * cellSize;
      if (stableRegion && !stableRegion(u, v)) continue;
      cells.push({ u, v, dz: dzRaw[idx] });
    }
  }
  if (cells.length < 8) return { a: 0, b: 0, c: 0, sigma: Infinity, inliers: 0 };

  let weights = cells.map(() => 1);
  let fit = { a: 0, b: 0, c: 0 };
  let sigma = Infinity;
  let inliers = cells.length;
  for (let iter = 0; iter < 4; iter += 1) {
    fit = lsqPlane(cells, weights) ?? fit;
    const res = cells.map((p) => p.dz - (fit.a * p.u + fit.b * p.v + fit.c));
    const med = median(res);
    const mad = median(res.map((r) => Math.abs(r - med)));
    sigma = 1.4826 * mad;
    if (!(sigma > 0)) break;
    const cut = 3 * sigma;
    let kept = 0;
    weights = res.map((r) => {
      const w = Math.abs(r - med) <= cut ? 1 : 0;
      kept += w;
      return w;
    });
    inliers = kept;
    if (kept < Math.max(8, cells.length * 0.2)) break;
  }
  return { ...fit, sigma, inliers };
}

function lsqPlane(cells, weights) {
  let Suu = 0, Suv = 0, Svv = 0, Su = 0, Sv = 0, S1 = 0;
  let Sud = 0, Svd = 0, Sd = 0;
  for (let i = 0; i < cells.length; i += 1) {
    const w = weights[i];
    if (w <= 0) continue;
    const { u, v, dz } = cells[i];
    Suu += w * u * u; Suv += w * u * v; Svv += w * v * v;
    Su += w * u; Sv += w * v; S1 += w;
    Sud += w * u * dz; Svd += w * v * dz; Sd += w * dz;
  }
  if (S1 < 4) return null;
  // 3x3 正規方程式（ピボット付き掃き出し）
  const m = [
    [Suu, Suv, Su, Sud],
    [Suv, Svv, Sv, Svd],
    [Su, Sv, S1, Sd],
  ];
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < 3; r += 1) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-14) return null;
    if (pivot !== col) { const t = m[pivot]; m[pivot] = m[col]; m[col] = t; }
    const d = m[col][col];
    for (let x = col; x < 4; x += 1) m[col][x] /= d;
    for (let r = 0; r < 3; r += 1) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let x = col; x < 4; x += 1) m[r][x] -= f * m[col][x];
    }
  }
  return { a: m[0][3], b: m[1][3], c: m[2][3] };
}

// ---------------------------------------------------------------- まとまり

/**
 * 有意セルを8連結でまとめる。単発セルは多重検定の当たりくじの可能性が
 * 高いので、minCells 未満のまとまりは「参考」扱い（呼び出し側で輪郭だけ描く）。
 */
export function groupChangedCells(result, { minCells = 3 } = {}) {
  const { cols, rows, cellSize } = result.grid;
  const seen = new Uint8Array(cols * rows);
  const regions = [];
  for (let i = 0; i < result.significant.length; i += 1) {
    if (!result.significant[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    const cells = [];
    let peak = 0;
    let peakCell = i;
    while (stack.length) {
      const cIdx = stack.pop();
      cells.push(cIdx);
      if (Math.abs(result.dz[cIdx]) > Math.abs(peak)) {
        peak = result.dz[cIdx];
        peakCell = cIdx;
      }
      const col = cIdx % cols;
      const row = Math.floor(cIdx / cols);
      for (let jy = -1; jy <= 1; jy += 1) {
        for (let jx = -1; jx <= 1; jx += 1) {
          if (!jx && !jy) continue;
          const nc = col + jx;
          const nr = row + jy;
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
          const nb = nr * cols + nc;
          if (result.significant[nb] && !seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        }
      }
    }
    // 進行量の代表値。最大セルは「一番運の悪いノイズ」を必ず拾って過大になる
    // （セルσ1.5mm × 数十セルの最大値統計で +3mm 級）ので、
    // ピーク周辺 3×3 の平均を代表値にする。帳票に書くのはこちら
    const pc = peakCell % cols;
    const pr = Math.floor(peakCell / cols);
    let msum = 0;
    let mn = 0;
    for (let jy = -1; jy <= 1; jy += 1) {
      for (let jx = -1; jx <= 1; jx += 1) {
        const nc = pc + jx;
        const nr = pr + jy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const nb = nr * cols + nc;
        if (!Number.isFinite(result.dz[nb])) continue;
        msum += result.dz[nb];
        mn += 1;
      }
    }
    regions.push({
      cells,
      cellCount: cells.length,
      grouped: cells.length >= minCells,
      peak,
      magnitude: mn ? msum / mn : peak,
      peakAt: { col: pc, row: pr },
      areaSquared: cells.length * cellSize * cellSize,
    });
  }
  regions.sort((a, b) => Math.abs(b.peak) - Math.abs(a.peak));
  return regions;
}
