/**
 * 経時管理パネル。
 *
 * 測点を登録し、解析のたびに1回ぶんの観測として積む。
 * 判定はすべて history.js（純粋ロジック・検証済み）に任せ、
 * ここは入出力と描画だけを持つ。
 *
 * 保存先はブラウザの localStorage。サーバーには何も送りません。
 * ただし localStorage は端末を替えると消えるので、
 * **JSON の書き出しを「保存」として扱ってください**。UI でもそう案内しています。
 */

import {
  createStation, addObservation, latestComparison, cumulativeComparison,
  compareEpochsWithTemperature,
  fitTrend, temperatureAdjusted, yearsToThreshold,
  serialize, deserialize, toCSV,
} from './history.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'crack-tracking/history/v1';

let stations = [];
let selectedId = null;
let getMeasurement = () => null;

export function initHistoryPanel(options = {}) {
  getMeasurement = options.getMeasurement ?? (() => null);

  stations = load();
  selectedId = stations[0]?.id ?? null;

  $('stationAdd').addEventListener('click', addStation);
  $('stationSelect').addEventListener('change', (e) => {
    selectedId = e.target.value || null;
    render();
  });
  $('obsRecord').addEventListener('click', recordObservation);
  $('obsValueSource').addEventListener('change', renderRecordForm);
  $('obsSigma').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  $('historyExportJSON').addEventListener('click', exportJSON);
  $('historyExportCSV').addEventListener('click', exportCSV);
  $('historyImport').addEventListener('click', () => $('historyImportInput').click());
  $('historyImportInput').addEventListener('change', importJSON);
  $('stationDelete').addEventListener('click', deleteStation);

  render();
}

/** 解析が終わったら呼ぶ。記録フォームの選択肢を作り直す。 */
export function refreshHistoryPanel() {
  renderRecordForm();
}

// ---------------------------------------------------------------- 保存

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? deserialize(raw) : [];
  } catch (err) {
    console.warn('[history] 読み込めませんでした', err);
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(stations));
  } catch (err) {
    // 容量超過など。黙って失われるのが一番まずいので必ず出す
    banner('bad', '保存できませんでした',
      `${err.message}。JSON を書き出して控えてください。`);
  }
}

function current() {
  return stations.find((s) => s.id === selectedId) ?? null;
}

// ---------------------------------------------------------------- 操作

function addStation() {
  const name = $('stationName').value;
  if (!name.trim()) {
    banner('warn', '測点の名前を入れてください', 'あとで自分が分かる名前にしてください（例: A-1 橋台west面 上段き裂）');
    return;
  }
  try {
    const station = createStation({
      name,
      member: $('stationMember').value,
      thresholdMM: parseFloat($('stationThreshold').value),
    });
    stations = [...stations, station];
    selectedId = station.id;
    $('stationName').value = '';
    save();
    render();
  } catch (err) {
    banner('bad', '測点を作れませんでした', err.message);
  }
}

function deleteStation() {
  const station = current();
  if (!station) return;
  const n = station.observations.length;
  const ok = window.confirm(
    `測点「${station.name}」を観測 ${n} 件ごと削除します。元に戻せません。よろしいですか？`
  );
  if (!ok) return;
  stations = stations.filter((s) => s.id !== station.id);
  selectedId = stations[0]?.id ?? null;
  save();
  render();
}

function recordObservation() {
  const station = current();
  if (!station) {
    banner('warn', '測点を選んでください', '先に測点を登録してください。');
    return;
  }
  const m = getMeasurement();
  const source = $('obsValueSource').value;
  if (!m && source !== 'manual') {
    banner('warn', '解析結果がありません',
      '先に σ を実測してスケールを決めるか、「手入力」を選んでください。');
    return;
  }
  let valueMM;
  if (source === 'manual') {
    valueMM = parseFloat($('obsValue').value);
    if (!Number.isFinite(valueMM)) {
      banner('warn', '計測値を入れてください', 'ターゲット対を選ぶか、実測値を手で入れてください。');
      return;
    }
  } else {
    const pair = m.pairs.find((p) => p.label === source);
    if (!pair) {
      banner('warn', 'その対が見つかりません', '解析をやり直してから記録してください。');
      return;
    }
    valueMM = pair.meanMM;
  }

  // σ は解析から自動で入るが、ノギスなど別手段で測った場合は手で入れられる。
  // 空のまま記録すると有意判定はしない（差だけ残す）
  const sigmaMM = parseFloat($('obsSigma').value);

  try {
    const updated = addObservation(station, {
      at: $('obsAt').value ? new Date($('obsAt').value).toISOString() : (m?.at ?? Date.now()),
      valueMM,
      pairSigmaMM: sigmaMM,
      temperatureC: parseFloat($('obsTemp').value),
      weather: $('obsWeather').value,
      method: m?.method ?? '手入力',
      frames: m?.frames ?? null,
      bulgeMM: m?.bulgeMM ?? null,
      note: $('obsNote').value,
    });
    stations = stations.map((s) => (s.id === station.id ? updated : s));
    save();
    render();
    banner(Number.isFinite(sigmaMM) ? 'good' : 'warn', '記録しました',
      `${station.name} の観測が ${updated.observations.length} 件になりました。`
      + (Number.isFinite(sigmaMM)
        ? 'JSON を書き出して控えておくと端末を替えても残ります。'
        : 'σ が空なので、この回は有意判定をしません（差だけ残します）。'));
  } catch (err) {
    banner('bad', '記録できませんでした', err.message);
  }
}

function exportJSON() {
  download(serialize(stations), 'crack-history.json', 'application/json');
}

function exportCSV() {
  // Excel が UTF-8 と判るように BOM を付ける
  download('﻿' + toCSV(stations), 'crack-history.csv', 'text/csv');
}

async function importJSON(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const incoming = deserialize(await file.text());
    // 同じ id は上書き、無いものは追加。取り込みで既存が消えないようにする
    const byId = new Map(stations.map((s) => [s.id, s]));
    for (const s of incoming) byId.set(s.id, s);
    stations = [...byId.values()];
    selectedId = incoming[0]?.id ?? selectedId;
    save();
    render();
    banner('good', '取り込みました', `測点 ${incoming.length} 件。既存は残してあります。`);
  } catch (err) {
    banner('bad', '取り込めませんでした', err.message);
  }
}

function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- 描画

function render() {
  renderStationSelect();
  renderRecordForm();
  renderHistory();
}

function renderStationSelect() {
  const select = $('stationSelect');
  select.innerHTML = stations.length
    ? stations.map((s) =>
      `<option value="${s.id}"${s.id === selectedId ? ' selected' : ''}>`
      + `${escapeHtml(s.name)}（${s.observations.length} 回）</option>`).join('')
    : '<option value="">測点がありません</option>';
  $('stationDelete').disabled = !current();
}

function renderRecordForm() {
  const m = getMeasurement();
  const select = $('obsValueSource');
  const previous = select.value;

  const options = [
    ...(m?.pairs ?? []).map((p) =>
      `<option value="${escapeHtml(p.label)}">ターゲット対 ${escapeHtml(p.label)}`
      + `（${p.meanMM.toFixed(3)} mm）</option>`),
    '<option value="manual">手入力</option>',
  ];
  select.innerHTML = options.join('');
  if (previous && [...select.options].some((o) => o.value === previous)) select.value = previous;

  $('obsValueRow').style.display = select.value === 'manual' ? '' : 'none';

  // σ は自動で入れるが、一度手で書き換えられていたら尊重する
  if (m && !$('obsSigma').dataset.touched) $('obsSigma').value = m.pairSigmaMM.toFixed(4);

  $('obsStatus').innerHTML = m
    ? `<p class="note">直近の解析: ${m.method} 方式・${m.frames} 枚・`
      + `分解能 ${m.gsd.toFixed(4)} mm/px、`
      + `2点間の σ <span class="mono">${m.pairSigmaMM.toFixed(4)} mm</span>`
      + `${m.bulgeMM != null ? `、はらみ出し ${m.bulgeMM.toFixed(1)} mm` : ''}</p>`
    : '<p class="note">解析結果がまだありません。σ を実測し、スケールを決めると記録できます。</p>';

  $('obsRecord').disabled = !current();
}

function renderHistory() {
  const station = current();
  if (!station) {
    $('historyBody').innerHTML = '<p class="note">測点を登録すると、ここに履歴が出ます。</p>';
    $('trendCanvas').classList.add('hidden');
    return;
  }

  const obs = station.observations;
  if (!obs.length) {
    $('historyBody').innerHTML = '<p class="note">まだ観測がありません。</p>';
    $('trendCanvas').classList.add('hidden');
    return;
  }

  // 傾きを先に出し、その温度係数を前回比較にも効かせる。
  // これをやらないと「傾きは進行なし・前回比較は有意」という食い違いが出る
  const trend = fitTrend(obs);
  const latest = latestComparison(station, 3, trend);
  const cumulative = cumulativeComparison(station, 3, trend);

  let html = '';

  if (latest) {
    html += verdictBlock('前回との差', latest);
    if (cumulative && obs.length > 2) html += verdictBlock('初回からの累積', cumulative);
  } else {
    html += '<div class="banner warn"><div><b>まだ比べられません</b><br>'
      + '2回目の観測から差の判定ができます。</div></div>';
  }

  html += renderTrend(trend, station, obs);
  html += renderTable(station, obs, trend);
  $('historyBody').innerHTML = html;

  drawTrend(obs, trend);
}

function verdictBlock(title, cmp) {
  if (cmp.significant == null) {
    return `<div class="banner warn"><div><b>${title}: ${fmtSigned(cmp.deltaMM)} mm</b><br>`
      + 'σ が記録されていないので有意かどうか判定できません。</div></div>';
  }
  const kind = cmp.significant ? 'bad' : 'good';
  const word = cmp.significant ? '有意な変化' : '有意差なし';

  const temperature = cmp.temperatureAdjusted
    ? `<br>生の差は ${fmtSigned(cmp.rawDeltaMM)} mm ですが、`
      + `気温が ${fmtSigned(cmp.deltaTemperatureK, 1)}K 変わっており、`
      + `そのうち <span class="mono">${fmtSigned(cmp.temperatureExplainedMM)} mm</span> は`
      + '温度で説明できます。上の数値は差し引いた残りです。'
    : '';

  return `<div class="banner ${kind}"><div>
    <b>${title}: ${fmtSigned(cmp.deltaMM)} mm → ${word}</b><br>
    差の検出限界は <span class="mono">${cmp.limitMM.toFixed(4)} mm</span>
    （限界の ${cmp.ratio.toFixed(2)} 倍）。
    2時期を比べるので両日のばらつきが乗り、1日ぶんの 3σ より √2 倍ほど広くなります。${temperature}
  </div></div>`;
}

function renderTrend(trend, station, obs) {
  if (!trend.ok) {
    return `<h3 class="sec">傾き</h3><p class="note">${escapeHtml(trend.reason)}</p>`;
  }

  const cells = [
    ['進行', `${fmtSigned(trend.perYearMM, 4)} mm/年`,
      trend.significant ? '有意' : '有意でない'],
    ['95%信頼区間', `${fmtPlain(trend.perYearCI[0])} 〜 ${fmtPlain(trend.perYearCI[1])}`, 'mm/年'],
    ['残差', `${fmtPlain(trend.residualSigmaMM)} mm`, `${trend.n} 回・${trend.spanYears.toFixed(1)} 年`],
  ];
  if (trend.temperatureSeparated) {
    cells.push(['温度係数', `${fmtSigned(trend.perKelvinMM, 5)} mm/K`,
      trend.perKelvinSignificant ? '有意（分離済み）' : '有意でない']);
  }

  let note = '';
  if (trend.temperatureNote) {
    note += `<div class="banner warn"><div>${escapeHtml(trend.temperatureNote)}</div></div>`;
  }
  if (trend.temperatureSeparated) {
    note += '<p class="note">温度で説明できるぶんを差し引いた「正味の進行」です。'
      + '係数は文献値ではなく、この測点自身のデータから回帰で出しています。</p>';
  }

  if (station.thresholdMM != null && trend.significant) {
    // 起点は最終観測の生値ではなく、回帰直線上の現在値。
    // 冬に測った回を起点にすると、温度で開いたぶんだけ到達が早く出る
    const currentOnLine = trend.interceptMM + trend.perYearMM * trend.spanYears;
    const reach = yearsToThreshold(trend, currentOnLine, station.thresholdMM);
    if (reach) {
      note += `<div class="banner warn"><div><b>しきい値 ${station.thresholdMM} mm への到達</b><br>`
        + `点推定 <span class="mono">${reach.years.toFixed(1)} 年</span>`
        + (reach.fastestYears && reach.slowestYears
          ? `（95%区間で ${reach.fastestYears.toFixed(1)} 〜 ${reach.slowestYears.toFixed(1)} 年）`
          : '')
        + `<br>起点は回帰直線上の現在値 ${currentOnLine.toFixed(3)} mm`
        + `${trend.temperatureSeparated ? '（平均気温 ' + trend.temperatureMeanC.toFixed(1) + '℃ 相当）' : ''}。`
        + `${reach.note}。</div></div>`;
    }
  }

  return `<h3 class="sec">傾き</h3>
    <div class="stats">${cells.map(([k, v, s]) => statCell(k, v, s)).join('')}</div>${note}`;
}

function renderTable(station, obs, trend) {
  const rows = obs.map((o, i) => {
    const prev = i > 0 ? obs[i - 1] : null;
    const cmp = prev ? compareEpochsWithTemperature(prev, o, trend) : null;
    return `<tr>
      <td>${o.at.slice(0, 10)}</td>
      <td class="num">${o.valueMM.toFixed(4)}</td>
      <td class="num">${o.pairSigmaMM != null ? o.pairSigmaMM.toFixed(4) : '—'}</td>
      <td class="num">${cmp ? fmtSigned(cmp.deltaMM) : '—'}${cmp?.temperatureAdjusted ? '<span style="color:var(--forest)">*</span>' : ''}</td>
      <td>${cmp?.significant == null ? '—' : (cmp.significant
        ? '<span style="color:var(--critical)">有意</span>'
        : '<span style="color:var(--ink-soft)">なし</span>')}</td>
      <td class="num">${o.temperatureC != null ? o.temperatureC.toFixed(1) : '—'}</td>
      <td>${escapeHtml(o.weather || '')}</td>
      <td class="num">${o.bulgeMM != null ? o.bulgeMM.toFixed(1) : '—'}</td>
      <td>${escapeHtml(o.note || '')}</td>
    </tr>`;
  }).join('');

  return `<h3 class="sec">履歴</h3><div class="scroll-x"><table>
    <thead><tr>
      <th>日</th><th class="num">計測値(mm)</th><th class="num">σ(mm)</th>
      <th class="num">前回差</th><th>判定</th>
      <th class="num">気温</th><th>天候</th><th class="num">はらみ(mm)</th><th>備考</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    ${obs.some((o, i) => i > 0 && compareEpochsWithTemperature(obs[i - 1], o, trend)?.temperatureAdjusted)
      ? '<p class="note"><span style="color:var(--forest)">*</span> 温度で説明できるぶんを差し引いた値です。</p>'
      : ''}`;
}

/**
 * 経時グラフ。
 *
 * 各点に「その回の 3σ」をひげとして描く。折れ線だけを見せると
 * ノイズの範囲内の上下動を進行と読まれるので、必ず一緒に描く。
 */
function drawTrend(obs, trend) {
  const canvas = $('trendCanvas');
  canvas.classList.remove('hidden');
  const W = 760, H = 280, pad = { l: 62, r: 16, t: 16, b: 34 };
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = '100%';
  canvas.style.maxWidth = `${W}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0e0c';
  ctx.fillRect(0, 0, W, H);

  const times = obs.map((o) => Date.parse(o.at));
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  const tSpan = tMax - tMin || 1;

  const errs = obs.map((o) => (o.pairSigmaMM != null ? 3 * o.pairSigmaMM : 0));
  const lo = Math.min(...obs.map((o, i) => o.valueMM - errs[i]));
  const hi = Math.max(...obs.map((o, i) => o.valueMM + errs[i]));
  const margin = (hi - lo) * 0.15 || 0.05;
  const yMin = lo - margin;
  const yMax = hi + margin;

  const X = (t) => pad.l + ((t - tMin) / tSpan) * (W - pad.l - pad.r);
  const Y = (v) => H - pad.b - ((v - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  // 目盛り
  ctx.strokeStyle = '#253028';
  ctx.fillStyle = '#67766d';
  ctx.font = '11px SFMono-Regular, Menlo, monospace';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const v = yMin + ((yMax - yMin) * i) / 4;
    const y = Y(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(v.toFixed(3), pad.l - 7, y + 4);
  }
  ctx.textAlign = 'center';
  ctx.fillText(new Date(tMin).toISOString().slice(0, 10), pad.l + 34, H - 12);
  if (tMax > tMin) ctx.fillText(new Date(tMax).toISOString().slice(0, 10), W - pad.r - 34, H - 12);

  // 回帰直線（温度分離後は平均気温での線）
  if (trend.ok) {
    const y0 = trend.interceptMM;
    const y1 = trend.interceptMM + trend.perYearMM * ((tMax - tMin) / (365.2425 * 86400000));
    ctx.strokeStyle = trend.significant ? '#c9564e' : '#4a5b51';
    ctx.lineWidth = 1.5;
    ctx.setLineDash(trend.significant ? [] : [5, 4]);
    ctx.beginPath();
    ctx.moveTo(X(tMin), Y(y0));
    ctx.lineTo(X(tMax), Y(y1));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 3σ のひげ
  ctx.strokeStyle = '#8a6420';
  ctx.lineWidth = 1.2;
  obs.forEach((o, i) => {
    if (!errs[i]) return;
    const x = X(times[i]);
    ctx.beginPath();
    ctx.moveTo(x, Y(o.valueMM - errs[i]));
    ctx.lineTo(x, Y(o.valueMM + errs[i]));
    ctx.moveTo(x - 4, Y(o.valueMM - errs[i]));
    ctx.lineTo(x + 4, Y(o.valueMM - errs[i]));
    ctx.moveTo(x - 4, Y(o.valueMM + errs[i]));
    ctx.lineTo(x + 4, Y(o.valueMM + errs[i]));
    ctx.stroke();
  });

  // 実測点
  ctx.fillStyle = '#d99a2b';
  obs.forEach((o, i) => {
    ctx.beginPath();
    ctx.arc(X(times[i]), Y(o.valueMM), 3.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // 温度補正後の系列
  const adjusted = temperatureAdjusted(obs, trend);
  if (adjusted) {
    ctx.fillStyle = '#4a9d72';
    adjusted.forEach((o) => {
      ctx.beginPath();
      ctx.arc(X(Date.parse(o.at)), Y(o.adjustedMM), 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  $('trendLegend').innerHTML =
    '<span style="color:var(--amber)">●</span> 実測値'
    + ' &nbsp;·&nbsp; <span style="color:var(--amber-dim)">Ⅰ</span> その回の 3σ'
    + (adjusted ? ' &nbsp;·&nbsp; <span style="color:var(--forest)">●</span> 温度補正後' : '')
    + (trend.ok
      ? ` &nbsp;·&nbsp; <span style="color:${trend.significant ? 'var(--critical)' : 'var(--ink-dim)'}">—</span>`
        + ` 回帰直線（${trend.significant ? '有意' : '有意でない'}）`
      : '');
}

// ---------------------------------------------------------------- 小物

function statCell(label, value, sub) {
  return `<div class="stat"><div class="k">${escapeHtml(label)}</div>`
    + `<div class="v">${escapeHtml(value)}</div>`
    + `<div class="k" style="margin-top:3px">${escapeHtml(sub)}</div></div>`;
}

function banner(kind, title, body) {
  $('historyMessage').innerHTML =
    `<div class="banner ${kind}"><div><b>${escapeHtml(title)}</b><br>${escapeHtml(body)}</div></div>`;
}

function fmtSigned(v, digits = 4) {
  if (!Number.isFinite(v)) return '—';
  // 表示桁より小さい値は 0 として出す。-0.0000 と出ると読み手が意味を探してしまう
  const rounded = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}`;
}

function fmtPlain(v, digits = 4) {
  if (!Number.isFinite(v)) return '—';
  const rounded = Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v;
  return rounded.toFixed(digits);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
