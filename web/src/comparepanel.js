/**
 * 比較パネル（2時期の変化抽出）。
 *
 * 「基準セット（前回の連写）」と「今回の写真セット」を重ね、
 * 有意に動いた場所と表面が変質した場所だけを塗る。
 * 判定はすべて change.js（純粋ロジック・検証済み）に任せ、
 * ここは入出力と描画だけを持つ。
 *
 * 基準セットはツールに保存しない。前回の連写をフォルダごと取っておいて、
 * 毎回ここへ読み込む運用（画像を localStorage に入れると容量が破綻する）。
 */

import { measureEpochChange, groupSignificant, fitTransformRobust } from './change.js';
import { decodeFile, toGray, downsample } from './image.js';
import { measureDisplacementField, estimateGlobalShift } from './dic.js';
import { residuals } from './transform.js';
import { summarize, median } from './sigma.js';
import { crackOpeningEpoch, crackFrame } from './crackline.js';
import { listBaselines, getBaseline } from './store.js';
import { setBaseline as setCaptureBaseline, liveActive, toggleLive } from './capturepanel.js';
import { closeSheet } from './shell.js';

const $ = (id) => document.getElementById(id);

// 実機のメモリを守るための上限。グレースケール1枚 = 幅×高さ×4バイト
const MAX_FRAMES_B = 5;

let getFrames = () => [];
let getGsd = () => null;
let getRoi = () => null;
let getLens = () => null;
let getSurface = () => null;
let onChange = () => {};
let baseFiles = [];
let baseCracks = [];      // 基準に保存された亀裂測点の線（基準画像の画素座標）
let onMeasurement = () => {};
let lastOutcome = null;   // 'changed' | 'surface' | 'quiet' | null

export function initComparePanel(options = {}) {
  getFrames = options.getFrames ?? (() => []);
  getGsd = options.getGsd ?? (() => null);
  getRoi = options.getRoi ?? (() => null);
  getLens = options.getLens ?? (() => null);
  getSurface = options.getSurface ?? (() => null);
  onChange = options.onChange ?? (() => {});
  onMeasurement = options.onMeasurement ?? (() => {});

  $('compareLoad').addEventListener('click', () => $('compareInput').click());
  $('compareInput').addEventListener('change', (e) => {
    baseFiles = [...(e.target.files ?? [])].filter(
      (f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|tiff?)$/i.test(f.name)
    );
    baseFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    baseCracks = [];
    $('compareBaseInfo').textContent = baseFiles.length
      ? `${baseFiles.length} 枚（1枚目が基準、2枚目を基準日の σ に使います）`
      : '';
    e.target.value = '';
    onChange();
  });

  $('compareRun').addEventListener('click', run);

  $('compareUseSaved').addEventListener('click', useSavedBaseline);
  $('compareRevisit').addEventListener('click', startRevisit);
  refreshSavedBaselines();
}

/** 保存済みの基準（測点）の一覧を出す。保存直後にも呼ばれる。 */
export async function refreshSavedBaselines() {
  const select = $('compareSaved');
  if (!select) return;
  try {
    const rows = await listBaselines();
    select.innerHTML = rows.length
      ? rows.map((r) =>
          `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}` +
          `（${r.count} 枚・${r.savedAt.slice(0, 10)}）</option>`).join('')
      : '<option value="">— 保存された測点はまだありません —</option>';
  } catch {
    select.innerHTML = '<option value="">— この端末では保存を使えません —</option>';
  }
}

/** 保存済みの基準を基準セットとして使う。フォルダ読み込みの置き換え。 */
async function useSavedBaseline() {
  const name = $('compareSaved').value;
  if (!name) { banner('warn', '測点がありません', '結果シートの「基準として保存」で先に保存してください。'); return; }
  const row = await getBaseline(name);
  if (!row) { banner('warn', '読み出せませんでした', '保存が消えている可能性があります。'); return; }
  baseFiles = row.frames.map((b, i) => new File([b], `${name}_${i}.jpg`, { type: 'image/jpeg' }));
  baseCracks = Array.isArray(row.meta?.cracks) ? row.meta.cracks : [];
  $('compareBaseInfo').textContent =
    `基準「${name}」 ${baseFiles.length} 枚（${row.savedAt.slice(0, 10)} 保存）`
    + (baseCracks.length ? `・亀裂 ${baseCracks.map((c) => c.label).join('・')}` : '');
  onChange();
}

/**
 * 再訪ガイド。保存済みの基準とライブ映像を機械が照合し、
 * 矢印で立ち位置を誘導、位置が合ったら自動でセッションを始める。
 * 人がやるのは歩くことだけ。
 */
async function startRevisit() {
  const name = $('compareSaved').value;
  if (!name) { banner('warn', '測点がありません', '結果シートの「基準として保存」で先に保存してください。'); return; }
  const row = await getBaseline(name);
  if (!row) { banner('warn', '読み出せませんでした', '保存が消えている可能性があります。'); return; }

  // 比較用の基準もこの測点に揃える（撮影後そのまま「変化を抽出」できる）
  baseFiles = row.frames.map((b, i) => new File([b], `${name}_${i}.jpg`, { type: 'image/jpeg' }));
  baseCracks = Array.isArray(row.meta?.cracks) ? row.meta.cracks : [];
  $('compareBaseInfo').textContent = `基準「${name}」 ${baseFiles.length} 枚`
    + (baseCracks.length ? `・亀裂 ${baseCracks.map((c) => c.label).join('・')}` : '');

  const refImage = await decodeFile(baseFiles[0]);
  const factor = Math.max(1, Math.round(refImage.width / 420));
  const small = downsample(toGray(refImage, null, 'luma', true), factor);
  const bitmap = await createImageBitmap(baseFiles[0]);
  setCaptureBaseline({ small, bitmap, name });

  try {
    if (!liveActive()) await toggleLive();
    closeSheet();
  } catch (err) {
    setCaptureBaseline(null);
    banner('bad', 'カメラを起動できませんでした', escapeHtml(err.message));
  }
  onChange();
}

/** レールのドット用。変化あり=赤 / 表面変質のみ=橙 / 変化なし=緑 / 未実行=灰 */
export function compareLamp() {
  if (lastOutcome === 'changed') return 'bad';
  if (lastOutcome === 'surface') return 'warn';
  if (lastOutcome === 'quiet') return 'good';
  return null;
}

function status(html) {
  $('compareStatus').innerHTML = html;
}

function banner(kind, title, body) {
  status(`<div class="banner ${kind}"><div><b>${title}</b><br>${body}</div></div>`);
}

async function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function run() {
  const frames = getFrames();
  if (!baseFiles.length) {
    banner('warn', '基準セットがありません', '前回撮った連写をここへ読み込んでください。');
    return;
  }
  if (frames.length < 2) {
    banner('warn', '今回セットが足りません',
      '写真シートに今回の連写を2枚以上読み込んでください。フレーム間のばらつきが判定の物差しになります。');
    return;
  }

  const channel = $('channel').value;
  const subsetHalf = clampInt($('subsetHalf').value, 5, 60, 15);
  $('compareRun').disabled = true;

  try {
    status('<p class="note">基準画像を読み込み中…</p>');
    await tick();
    const baseImage = await decodeFile(baseFiles[0]);
    const grayA = toGray(baseImage, null, channel, true);

    // 基準日の σ。基準画像自身のノイズは今回セットのばらつきに出ないので、
    // ここで測って限界に足す（2枚無ければ床値だけで判定し、その旨を明示）
    let sigmaAPx = null;
    if (baseFiles.length >= 2) {
      status('<p class="note">基準日の σ を実測中…</p>');
      await tick();
      const second = toGray(await decodeFile(baseFiles[1]), null, channel, true);
      const shift = estimateGlobalShift(grayA, second, downsample, { maxShiftPx: 300 });
      const field = measureDisplacementField(grayA, second, {
        subsetHalf, step: 40, searchRange: 3, minZNCC: 0.75, initialShift: shift,
      });
      if (field.points.length >= 12) {
        const fit = fitTransformRobust(field.points, false);
        if (fit.transform) {
          sigmaAPx = summarize(residuals(fit.transform, field.points)).sigma;
        }
      }
    }

    // 今回セット。全フレームを同時にグレースケール化するとメモリが持たないので、
    // 呼ばれたときに変換する形で渡す
    const used = frames.slice(0, MAX_FRAMES_B);
    const providers = used.map((f) => () => toGray(f.imageData, null, channel, true));

    const roi = getRoi();
    const stableRegion = $('compareStable').value === 'outside' && roi
      ? (x, y) => !(x >= roi.x && x <= roi.x + roi.width && y >= roi.y && y <= roi.y + roi.height)
      : null;

    const result = await measureEpochChange(grayA, providers, {
      subsetHalf,
      step: 40,
      minZNCC: 0.7,
      useHomography: true,
      stableRegion,
      sigmaAPx,
      downsample,
      // 4000px 級では段階1を縮小画像で回す
      coarseScale: Math.max(1, Math.round(grayA.width / 1000)),
      lens: getLens?.() ?? null,
      // 立ち位置が違うと、面から出た所だけが余分に動く。点群があれば計算して引く
      parallax: getSurface?.(grayA.width, grayA.height) ?? null,
      yieldBetweenFrames: tick,
      onFrame: (i, n) => status(`<p class="note">比較中… ${i + 1} / ${n} 枚</p>`),
    });

    if (!result.ok) {
      lastOutcome = null;
      banner('bad', '比較できませんでした',
        `${result.reason}。構図が大きく違うか、照明条件が違いすぎる可能性があります。`
        + '同じ立ち位置・同じ時間帯で撮り直すか、基準セットを確認してください。');
      return;
    }

    // 亀裂測点。基準に保存された線の両側で、2時期の相対変位を取る。
    // step は上の measureEpochChange と同じ 40。margin はサブセットが線をまたがない幅
    const crackRows = baseCracks.map((crack) => ({
      crack,
      ...crackOpeningEpoch(result.cells, crack, {
        margin: subsetHalf + 5,
        depth: 40 * 4,
        systematicFloorPx: result.systematicFloorPx ?? 0.02,
      }),
    }));

    render(result, grayA, {
      sigmaAPx, usedFrames: used.length, totalFrames: frames.length, crackRows, frames: used,
    });
  } catch (err) {
    lastOutcome = null;
    banner('bad', 'エラー', escapeHtml(err.message));
    console.error(err);
  } finally {
    $('compareRun').disabled = false;
    onChange();
  }
}

function render(result, grayA, context) {
  const gsd = getGsd();
  const toMM = (px) => (gsd ? `${(px * gsd).toFixed(3)} mm` : `${px.toFixed(3)} px`);

  const moved = groupSignificant(result, { minCells: 2 });
  const surface = groupSignificant(result, { minCells: 2, which: 'decorrelated' });

  lastOutcome = moved.length ? 'changed' : surface.length ? 'surface' : 'quiet';

  // ── 判定の一枚看板
  let verdict;
  if (moved.length) {
    const g = moved[0];
    verdict = `<div class="banner bad"><div><b>有意に動いた領域があります</b><br>`
      + `最大の領域: ${toMM(Math.hypot(g.du, g.dv))}（${g.cellCount} セル）。`
      + `方向 (${g.du.toFixed(2)}, ${g.dv.toFixed(2)}) px。図の矢印を確認してください。</div></div>`;
  } else if (surface.length) {
    verdict = `<div class="banner warn"><div><b>動きは検出限界内。ただし表面が変質した領域があります</b><br>`
      + `相関低下 ${result.stats.decorrelated} セル。き裂の進展・剥離・汚れ・濡れのどれかです。`
      + `図の青い領域を写真で確認してください。</div></div>`;
  } else {
    verdict = `<div class="banner good"><div><b>有意な変化はありません</b><br>`
      + `検出限界を超えて動いた場所も、表面が変質した場所もありません。</div></div>`;
  }

  // 影の移動は本物と同じ大きさの偽の変位を作る（合成検証で σ の 400 倍・1.1px 級）。
  // 落としたことを黙っていると、判定できていない場所が「変化なし」に化ける
  const litCells = result.stats.illuminationChanged ?? 0;
  if (litCells > 0) {
    const ratio = litCells / Math.max(1, result.stats.evaluated);
    verdict += `<div class="banner warn"><div><b>影が動いたと見られる領域は判定していません</b><br>`
      + `${litCells} セル（評価対象の ${(ratio * 100).toFixed(0)}%）で、2時期の局所的な明るさの比が`
      + `変わっています。図の斜線がその場所です。<b>ここは「変化なし」ではなく「判定できず」</b>です。`
      + (ratio > 0.25
        ? '広い範囲に及んでいます。前回と同じ時刻・同じ天候で撮り直すと精度が上がります。'
        : '前回と同じ時刻に撮ると減らせます。')
      + `</div></div>`;
  }

  // 立ち位置のずれが作る「見かけの変位」。点群があるときだけ扱える。
  // 効かせられなかったときも黙らない — 未補正と補正済みは違う
  const px = result.parallax;
  if (px?.ok && px.applied) {
    const cm = px.shiftMagnitudeMM / 10;
    verdict += `<div class="banner good"><div><b>立ち位置のずれを補正しました</b><br>`
      + `点群の凹凸から、前回との立ち位置の差を <b>${cm.toFixed(0)}cm</b> と推定し`
      + `（右 ${(px.shiftMM.x / 10).toFixed(0)}・下 ${(px.shiftMM.y / 10).toFixed(0)}・前 ${(px.shiftMM.z / 10).toFixed(0)} cm）、`
      + `${px.corrected} セルから視差を差し引きました。`
      + (px.afterRmsPx != null && px.beforeRmsPx != null
        ? `残差 ${toMM(px.afterRmsPx)}（補正前 ${toMM(px.beforeRmsPx)}）。` : '')
      + `</div></div>`;
  } else if (px && !px.ok) {
    verdict += `<div class="banner warn"><div><b>視差は補正していません</b><br>`
      + `${escapeHtml(px.reason)}。立ち位置が前回とずれていると、面から出っ張った所だけが`
      + `余分に動いて見えます（5m・凹凸20mm・横20cm で 0.5mm 級）。`
      + `凹凸の上の有意セルは、進行と決めつけずに写真で確かめてください。</div></div>`;
  } else if (!px) {
    verdict += `<p class="note">点群を読み込むと、立ち位置のずれが作る`
      + `見かけの変位（視差）を差し引けます。同じ位置に立てない現場ほど効きます。</p>`;
  }

  // ── 数値
  const cells = [
    ['時期またぎ σ', result.sigmaCrossPx != null ? toMM(result.sigmaCrossPx) : '—',
      'セルごとの実測（中央値）'],
    ['検出限界の目安', result.sigmaCrossPx != null
      ? toMM(result.k * Math.sqrt(
          result.sigmaCrossPx ** 2 / context.usedFrames
          + (result.sigmaAPx ?? 0) ** 2 + 0.02 ** 2))
      : '—', `${result.k}σ・${context.usedFrames} 枚`],
    ['評価セル', String(result.stats.evaluated), `使用 ${context.usedFrames}/${context.totalFrames} 枚`],
    ['有意に動いた', String(result.stats.significant), 'セル'],
    ['表面の変質', String(result.stats.decorrelated), 'セル'],
    ['影で判定できず', String(result.stats.illuminationChanged ?? 0), 'セル'],
    ['視差を補正', px?.ok && px.applied ? String(result.stats.parallaxCorrected ?? 0) : '—',
      px?.ok && px.applied ? `立ち位置のずれ ${(px.shiftMagnitudeMM / 10).toFixed(0)}cm` : '点群が要ります'],
  ];
  $('compareStats').innerHTML =
    `<div class="stats">${cells.map(([k, v, sub]) =>
      `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>`
      + `<div class="k" style="margin-top:3px">${sub}</div></div>`).join('')}</div>`
    + (context.sigmaAPx == null
      ? '<div class="banner warn"><div>基準セットが1枚なので基準日の σ を測れません。'
      + '限界は系統誤差の床だけで判定しています。次回から連写を基準に使ってください。</div></div>'
      : '')
    + (gsd == null
      ? '<p class="note">スケール未設定のため px 表示です。スケールシートで決めると mm になります。</p>'
      : '');

  status(verdict);
  drawMap(result, grayA, moved);
  renderCracks(result, grayA, context, gsd);
}

/**
 * 亀裂測点の結果。表にして、経時管理が拾える形（ターゲット対と同じ棚）で渡す。
 * 開口は「基準からの変化」。基準日には 0 ± σ が記録されている前提。
 */
function renderCracks(result, grayA, context, gsd) {
  const el = $('compareCracks');
  const rows = context.crackRows ?? [];
  if (!el) return;
  if (!rows.length) { el.innerHTML = ''; return; }
  const fmt = (px, signed = false) => {
    const v = gsd ? px * gsd : px;
    const unit = gsd ? 'mm' : 'px';
    return `${signed && v >= 0 ? '+' : ''}${v.toFixed(gsd ? 3 : 4)} ${unit}`;
  };
  const trs = rows.map((r) => {
    const f = crackFrame(r.crack);
    if (!r.ok) {
      return `<tr><td>${escapeHtml(r.crack.label)}</td><td>${f?.orientation ?? ''}</td>`
        + `<td colspan="4" class="note" style="padding:6px 8px">${escapeHtml(r.reason ?? '算出できませんでした')}</td></tr>`;
    }
    const sig = Math.abs(r.openingPx) > result.k * r.sePx;
    const shearSig = Math.abs(r.shearPx) > result.k * r.seShearPx;
    const ex = r.excluded ?? {};
    const excludedNote = (ex.decorrelated || ex.illumination)
      ? `<br><span class="note">除外 相関低下 ${ex.decorrelated ?? 0}・影 ${ex.illumination ?? 0}</span>` : '';
    return `<tr>
      <td>${escapeHtml(r.crack.label)}</td><td>${f?.orientation ?? ''}</td>
      <td class="num"${sig ? ' style="color:var(--critical);font-weight:700"' : ''}>${fmt(r.openingPx, true)}<br><span class="note">± ${fmt(r.sePx)}</span></td>
      <td class="num"${shearSig ? ' style="color:var(--amber);font-weight:700"' : ''}>${fmt(r.shearPx, true)}<br><span class="note">± ${fmt(r.seShearPx)}</span></td>
      <td>${sig ? '<b>有意</b>' : '限界内'}${shearSig ? '・ずれ有意' : ''}</td>
      <td class="num">${r.n1} / ${r.n2}${excludedNote}</td></tr>`;
  });
  el.innerHTML = `
    <h3 class="sec">亀裂測点 — 基準からの開口の変化</h3>
    <div class="scroll-x"><table>
      <tr><th>亀裂</th><th>向き</th><th class="num">開口（線に直交）</th><th class="num">ずれ（線に沿う）</th><th>判定 ${result.k}σ</th><th class="num">点数 側1 / 側2</th></tr>
      ${trs.join('')}
    </table></div>
    <p class="note">正の開口は「開いた」、負は「閉じた」。ずれは縦線なら正＝右側が下がった、横線なら正＝上側が右へ動いた。
      ± は標準誤差（両側の点の散らばり／√n と系統誤差の床${result.parallax?.ok && result.parallax.applied ? '、視差補正の誤差' : ''}の合成）。
      ${gsd ? '経時シートで「この測点の観測として記録」すると、この値が今回の観測になります。' : 'スケールを決めると mm になり、経時管理に記録できます。'}</p>`;

  // 図に線を重ねる（基準画像の座標＝図の座標）
  const canvas = $('compareCanvas');
  const ctx = canvas?.getContext('2d');
  if (ctx && grayA) {
    const scale = Math.min(1, 760 / grayA.width);
    ctx.save();
    ctx.strokeStyle = '#ff6b5e';
    ctx.lineWidth = 2;
    ctx.fillStyle = '#ff8a80';
    ctx.font = 'bold 13px SFMono-Regular, Menlo, monospace';
    for (const r of rows) {
      const c = r.crack;
      ctx.beginPath();
      ctx.moveTo(c.x1 * scale, c.y1 * scale);
      ctx.lineTo(c.x2 * scale, c.y2 * scale);
      ctx.stroke();
      ctx.fillText(c.label, c.x1 * scale + 5, c.y1 * scale - 5);
    }
    ctx.restore();
  }

  // 経時管理へ。スケールが無いと mm にならないので渡さない（px の記録は意味が混ざる）
  const ok = rows.filter((r) => r.ok);
  if (!gsd || !ok.length) return;
  const framesNow = context.frames ?? getFrames();
  const method = '亀裂測点（2時期 DIC）';
  onMeasurement({
    gsd,
    frames: context.usedFrames,
    method,
    atExif: framesNow[0]?.exif?.dateTimeOriginal ?? null,
    pairSigmaMM: median(ok.map((r) => r.sePx)) * gsd,
    bulgeMM: null,
    pairs: ok.map((r) => ({
      label: r.crack.label, kind: 'crack', method,
      meanPx: r.openingPx, meanMM: r.openingPx * gsd,
      sigmaPx: r.sePx, sigmaMM: r.sePx * gsd,
      shearMM: r.shearPx * gsd, sigmaShearMM: r.seShearPx * gsd,
      n1: r.n1, n2: r.n2,
    })),
  });
}

/**
 * 変化マップ。基準画像を淡く敷き、有意セルだけを塗る。
 * 「塗られたものは全部有意」— ノイズを面で描かないのはこのアプリ全体の約束。
 */
function drawMap(result, grayA, groups) {
  const canvas = $('compareCanvas');
  canvas.classList.remove('hidden');

  const scale = Math.min(1, 760 / grayA.width);
  const w = Math.round(grayA.width * scale);
  const h = Math.round(grayA.height * scale);
  canvas.width = w;
  canvas.height = h;

  // 基準画像（暗く敷く）
  const off = document.createElement('canvas');
  off.width = grayA.width;
  off.height = grayA.height;
  const octx = off.getContext('2d');
  const img = octx.createImageData(grayA.width, grayA.height);
  for (let i = 0; i < grayA.data.length; i += 1) {
    const v = Math.max(0, Math.min(255, Math.round(grayA.data[i] * 255 * 0.55)));
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  octx.putImageData(img, 0, 0);

  const ctx = canvas.getContext('2d');
  ctx.drawImage(off, 0, 0, w, h);

  const cell = Math.max(3, result.step * scale);
  const maxMag = Math.max(result.stats.maxMagnitudePx, 1e-9);

  // 隣接する有意セルの有無。200セルを 3σ で検定すれば単独のまぐれ当たりは
  // 期待値的に出る。単独セルは枠だけにして、まとまった領域と格を分ける
  const sigSet = new Set(
    result.cells.filter((c) => c.significant).map((c) => `${c.x},${c.y}`)
  );
  const hasSigNeighbour = (c) => {
    for (let dy = -result.step; dy <= result.step; dy += result.step) {
      for (let dx = -result.step; dx <= result.step; dx += result.step) {
        if (!dx && !dy) continue;
        if (sigSet.has(`${c.x + dx},${c.y + dy}`)) return true;
      }
    }
    return false;
  };

  // 影が動いたセルは「変化なし」ではなく「判定できず」。斜線で塗り分ける。
  // 未評価と良好を同じ見た目にすると、測れていない場所が問題なしに化ける
  const hatch = (x, y) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - cell / 2, y - cell / 2, cell, cell);
    ctx.clip();
    ctx.strokeStyle = 'rgba(160,160,160,0.5)';
    ctx.lineWidth = 1;
    for (let d = -cell; d < cell * 2; d += 5) {
      ctx.beginPath();
      ctx.moveTo(x - cell / 2 + d, y - cell / 2);
      ctx.lineTo(x - cell / 2 + d - cell, y + cell / 2);
      ctx.stroke();
    }
    ctx.restore();
  };

  for (const c of result.cells) {
    const x = c.x * scale;
    const y = c.y * scale;
    if (c.illuminationChanged) {
      hatch(x, y);
    } else if (c.decorrelated) {
      ctx.fillStyle = 'rgba(74,125,157,0.55)';
      ctx.fillRect(x - cell / 2, y - cell / 2, cell, cell);
    } else if (c.significant) {
      const t = Math.min(1, c.magnitudePx / maxMag);
      const colour = t < 0.6
        ? `rgba(217,154,43,${0.35 + t * 0.4})`
        : `rgba(201,86,78,${0.55 + t * 0.3})`;
      if (hasSigNeighbour(c)) {
        ctx.fillStyle = colour;
        ctx.fillRect(x - cell / 2, y - cell / 2, cell, cell);
      } else {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x - cell / 2, y - cell / 2, cell, cell);
      }
    }
  }

  // 領域の代表矢印（変位は 1px 未満なので誇張倍率で描き、倍率を凡例に書く）
  const exaggeration = 60;
  ctx.strokeStyle = '#f0f4f1';
  ctx.fillStyle = '#f0f4f1';
  ctx.lineWidth = 1.6;
  for (const g of groups.slice(0, 5)) {
    const cx = ((g.bounds.x0 + g.bounds.x1) / 2) * scale;
    const cy = ((g.bounds.y0 + g.bounds.y1) / 2) * scale;
    const ex = cx + g.du * exaggeration * scale;
    const ey = cy + g.dv * exaggeration * scale;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    const angle = Math.atan2(ey - cy, ex - cx);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 7 * Math.cos(angle - 0.4), ey - 7 * Math.sin(angle - 0.4));
    ctx.lineTo(ex - 7 * Math.cos(angle + 0.4), ey - 7 * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  $('compareLegend').innerHTML =
    '<span style="color:var(--amber)">■</span>→<span style="color:var(--critical)">■</span> 有意に動いた（濃いほど大）'
    + ' &nbsp;·&nbsp; <span style="color:#4a7d9d">■</span> 表面の変質（き裂進展・剥離など）'
    + ` &nbsp;·&nbsp; 矢印は変位を ${exaggeration} 倍に誇張`
    + ' &nbsp;·&nbsp; 枠だけ = 単独セル（隣接なし・弱い根拠）'
    + ' &nbsp;·&nbsp; 塗られていない場所は検出限界内';
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
