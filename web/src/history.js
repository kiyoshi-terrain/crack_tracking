/**
 * 経時管理。測点を登録して、前回との差が有意かを判定する。
 *
 * ## なぜ「差の検出限界」を別に計算するのか
 *
 * 1回の観測の検出限界（3σ）は、その日の中でのばらつきに対する限界です。
 * 2時期を比べるときは**両方の日のばらつきが乗る**ので、差の分散は
 * σ_A² + σ_B²。同じ精度で撮れていれば差の限界は √2 倍に広がります。
 * ここを 3σ のままにすると、有意でない変化を有意と言ってしまいます。
 *
 * ## 温度による見かけの開閉
 *
 * き裂は温めれば閉じ、冷やせば開きます。これは進行ではありません。
 * 係数を文献から借りてくるのではなく、**その測点自身のデータから回帰で出します**。
 * 石材・目地・拘束条件で実効係数は変わるので、借り物の値は当てになりません。
 *
 * 時間と温度を同時に入れた重回帰にすることで、
 * 「温度で説明できるぶんを除いた、正味の経年変化」が出ます。
 *
 * 依存なし・入出力は数値だけ。
 */

const MS_PER_DAY = 86400000;
const DAYS_PER_YEAR = 365.2425;

// 両側 95% の t 値。自由度 1〜30、それ以上は正規近似。
// 測点あたりの観測は数回〜十数回なので、正規近似で済ませると
// 少ない回数のときに有意と言い過ぎる。
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export function tCritical95(dof) {
  if (dof < 1) return Infinity;
  return dof <= T95.length ? T95[dof - 1] : 1.96;
}

// ---------------------------------------------------------------- 2時期の比較

/**
 * 2つの観測の差が有意かを判定する。
 *
 * @param {{valueMM: number, pairSigmaMM: number}} before
 * @param {{valueMM: number, pairSigmaMM: number}} after
 * @param {number} k 何σを限界とするか（既定 3）
 *
 * pairSigmaMM は「き裂を挟む2点の相対変位の σ」。sigma.js の
 * detectionLimit が返す pairSigmaMM をそのまま渡してください。
 */
export function compareEpochs(before, after, k = 3) {
  if (!before || !after) return null;
  const deltaMM = after.valueMM - before.valueMM;

  const sa = before.pairSigmaMM;
  const sb = after.pairSigmaMM;
  // null >= 0 は true になるので、比較演算子でガードしてはいけない。
  // 素通りすると σ が無いのに「有意」と表示される
  // σ が 0 以下も「測れていない」。0 を通すと限界 0・比 null のまま「有意」になり、
  // 表示側が比を書式化するところで落ちる
  if (!(sa > 0) || !(sb > 0)) {
    return { deltaMM, limitMM: null, significant: null, ratio: null };
  }

  // 差の分散は両方の分散の和。片方だけの 3σ で判定してはいけない
  const diffSigma = Math.hypot(sa, sb);
  const limitMM = k * diffSigma;

  return {
    deltaMM,
    limitMM,
    diffSigmaMM: diffSigma,
    significant: Math.abs(deltaMM) > limitMM,
    // 限界の何倍か。1.0 ちょうどを跨ぐ判定なので、比を出しておくと迷わない
    ratio: limitMM > 0 ? Math.abs(deltaMM) / limitMM : null,
    k,
  };
}

/**
 * 温度で説明できるぶんを差し引いてから、2時期の差を判定する。
 *
 * これが無いと、進行していないき裂でも**毎回「有意な変化」と出ます**。
 * 夏と冬で交互に測れば、温度による開閉がそのまま差として現れるためです。
 * 傾きの回帰では正しく「進行なし」と出るのに、前回比較だけが赤く光る、
 * という食い違いが起きます。
 *
 * 限界には温度係数自身の不確かさも足します。係数は推定値なので、
 * それを真値のように使うと差し引きすぎ／足りなさすぎを見逃します。
 *
 * @param {object} before
 * @param {object} after
 * @param {object} trend fitTrend の戻り値（温度を分離できているもの）
 */
export function compareEpochsWithTemperature(before, after, trend, k = 3) {
  const raw = compareEpochs(before, after, k);
  if (!raw) return null;

  const usable = trend?.ok && trend.temperatureSeparated && trend.perKelvinSignificant
    && Number.isFinite(before.temperatureC) && Number.isFinite(after.temperatureC);
  if (!usable) return raw;

  const deltaT = after.temperatureC - before.temperatureC;
  const explainedMM = trend.perKelvinMM * deltaT;
  const residualMM = raw.deltaMM - explainedMM;

  // 温度係数の標準誤差ぶんを限界に足す。係数を真値扱いしない
  const limitMM = raw.diffSigmaMM != null
    ? k * Math.hypot(raw.diffSigmaMM, deltaT * (trend.perKelvinStdErr ?? 0))
    : null;

  return {
    ...raw,
    rawDeltaMM: raw.deltaMM,
    deltaMM: residualMM,
    temperatureExplainedMM: explainedMM,
    deltaTemperatureK: deltaT,
    limitMM,
    significant: limitMM != null ? Math.abs(residualMM) > limitMM : null,
    ratio: limitMM > 0 ? Math.abs(residualMM) / limitMM : null,
    temperatureAdjusted: true,
  };
}

// ---------------------------------------------------------------- 回帰

/**
 * 正規方程式を解く（n×n のガウス消去、部分ピボット選択）。
 */
function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    if (pivot !== col) { const t = a[pivot]; a[pivot] = a[col]; a[col] = t; }

    const d = a[col][col];
    for (let c = col; c <= n; c += 1) a[col][c] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c += 1) a[r][c] -= f * a[col][c];
    }
  }
  return a.map((row) => row[n]);
}

/**
 * 最小二乗と、各係数の標準誤差。
 * @param {number[][]} design 各行が説明変数（定数項も明示的に含める）
 * @param {number[]} y
 */
function leastSquares(design, y) {
  const n = y.length;
  const p = design[0].length;
  if (n <= p) return null;

  const xtx = Array.from({ length: p }, () => new Array(p).fill(0));
  const xty = new Array(p).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let a = 0; a < p; a += 1) {
      xty[a] += design[i][a] * y[i];
      for (let b = 0; b < p; b += 1) xtx[a][b] += design[i][a] * design[i][b];
    }
  }

  const beta = solveLinearSystem(xtx, xty);
  if (!beta) return null;

  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    let fit = 0;
    for (let a = 0; a < p; a += 1) fit += design[i][a] * beta[a];
    sse += (y[i] - fit) ** 2;
  }
  const dof = n - p;
  const variance = sse / dof;

  // 係数の分散は variance × (XᵀX)⁻¹ の対角成分。
  // 逆行列は単位ベクトルを右辺に解いて列ごとに取る
  const stdErr = new Array(p).fill(NaN);
  for (let a = 0; a < p; a += 1) {
    const e = new Array(p).fill(0);
    e[a] = 1;
    const col = solveLinearSystem(xtx, e);
    if (col) stdErr[a] = Math.sqrt(Math.max(0, variance * col[a]));
  }

  const mean = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - mean) ** 2, 0);

  return {
    beta, stdErr, dof,
    residualSigma: Math.sqrt(variance),
    rSquared: sst > 0 ? 1 - sse / sst : null,
  };
}

/**
 * 経年変化の傾きを出す。温度が揃っていれば同時に分離する。
 *
 * @param {Array<{at: number|string|Date, valueMM: number, temperatureC?: number}>} observations
 * @param {{separateTemperature?: boolean}} options
 *        separateTemperature — 既定は「温度が全観測に揃っていれば自動で分離」
 *
 * @returns 傾き（mm/年）、温度係数（mm/K）、それぞれの標準誤差と有意判定
 */
export function fitTrend(observations, options = {}) {
  const rows = (observations ?? [])
    .map((o) => ({ ...o, t: toTime(o.at) }))
    .filter((o) => Number.isFinite(o.t) && Number.isFinite(o.valueMM))
    .sort((a, b) => a.t - b.t);

  if (rows.length < 3) {
    return { ok: false, reason: `観測が ${rows.length} 回では傾きを出せません（3回以上必要）`, n: rows.length };
  }

  const t0 = rows[0].t;
  const years = rows.map((r) => (r.t - t0) / MS_PER_DAY / DAYS_PER_YEAR);
  const y = rows.map((r) => r.valueMM);

  const hasTemp = rows.every((r) => Number.isFinite(r.temperatureC));
  // 気温がほぼ一定だと温度の列が定数になり、正規方程式が特異になる。
  // 「同じ季節にしか行っていない」現場では普通に起きるので、
  // 黙って回帰ごと失敗させず、分離を諦めて傾きだけ出す
  const tempRange = hasTemp
    ? Math.max(...rows.map((r) => r.temperatureC)) - Math.min(...rows.map((r) => r.temperatureC))
    : 0;
  const tempVaries = hasTemp && tempRange >= 0.5;
  const useTemp = options.separateTemperature ?? tempVaries;

  if (useTemp && !hasTemp) {
    return { ok: false, reason: '温度を分離するには全観測に気温が必要です', n: rows.length };
  }
  if (useTemp && !tempVaries) {
    return {
      ok: false,
      reason: `気温の幅が ${tempRange.toFixed(1)}K しかないので温度の影響を分離できません`
        + '（季節を変えて撮ってください）',
      n: rows.length,
    };
  }

  // 温度は平均を引いておく。切片が「平均気温での値」になって読みやすい
  const tempMean = hasTemp
    ? rows.reduce((s, r) => s + r.temperatureC, 0) / rows.length
    : 0;

  const design = rows.map((r, i) => (
    useTemp ? [1, years[i], r.temperatureC - tempMean] : [1, years[i]]
  ));

  const fit = leastSquares(design, y);
  if (!fit) {
    return { ok: false, reason: '回帰が解けませんでした（観測日が同じ、気温が全て同じなど）', n: rows.length };
  }

  const tCrit = tCritical95(fit.dof);
  const slope = fit.beta[1];
  const slopeErr = fit.stdErr[1];

  const result = {
    ok: true,
    n: rows.length,
    dof: fit.dof,
    interceptMM: fit.beta[0],
    perYearMM: slope,
    perYearStdErr: slopeErr,
    // 95% 信頼区間。傾きの数値だけ見せると必ず過大に読まれるので必ず添える
    perYearCI: [slope - tCrit * slopeErr, slope + tCrit * slopeErr],
    significant: Math.abs(slope) > tCrit * slopeErr,
    residualSigmaMM: fit.residualSigma,
    rSquared: fit.rSquared,
    spanYears: years[years.length - 1],
    temperatureSeparated: useTemp,
    temperatureRangeK: hasTemp ? tempRange : null,
  };

  if (!useTemp && hasTemp && !tempVaries) {
    result.temperatureNote = `気温の幅が ${tempRange.toFixed(1)}K しかないため分離していません。`
      + 'この傾きには温度による見かけの開閉が混ざっている可能性があります';
  } else if (!useTemp && !hasTemp) {
    result.temperatureNote = '気温が揃っていないため分離していません。'
      + 'この傾きには温度による見かけの開閉が混ざっている可能性があります';
  }

  if (useTemp) {
    result.perKelvinMM = fit.beta[2];
    result.perKelvinStdErr = fit.stdErr[2];
    result.perKelvinSignificant = Math.abs(fit.beta[2]) > tCrit * fit.stdErr[2];
    result.temperatureMeanC = tempMean;
  }

  return result;
}

/**
 * 温度で説明できるぶんを差し引いた系列を返す。図に重ねて見るためのもの。
 * 傾きの判定そのものは fitTrend が重回帰で済ませているので、これは表示用。
 */
export function temperatureAdjusted(observations, trend) {
  if (!trend?.ok || !trend.temperatureSeparated) return null;
  return observations
    .filter((o) => Number.isFinite(o.valueMM) && Number.isFinite(o.temperatureC))
    .map((o) => ({
      ...o,
      adjustedMM: o.valueMM - trend.perKelvinMM * (o.temperatureC - trend.temperatureMeanC),
    }));
}

/**
 * 「あと何年でしきい値に達するか」。
 *
 * 外挿は本来やるべきでないので、**傾きが有意なときだけ**返します。
 * 信頼区間の端から出した幅も一緒に返すので、点推定だけを見て
 * 判断されるのを防げます。
 */
export function yearsToThreshold(trend, currentMM, thresholdMM) {
  if (!trend?.ok || !trend.significant) return null;
  const remaining = thresholdMM - currentMM;
  if (remaining <= 0) return { years: 0, note: '既にしきい値に達しています' };
  if (trend.perYearMM <= 0) return null;

  const estimate = remaining / trend.perYearMM;
  const fastest = trend.perYearCI[1] > 0 ? remaining / trend.perYearCI[1] : null;
  const slowest = trend.perYearCI[0] > 0 ? remaining / trend.perYearCI[0] : null;

  return {
    years: estimate,
    // 早い側／遅い側。95% 信頼区間の端から
    fastestYears: fastest,
    slowestYears: slowest,
    note: '傾きが一定であると仮定した外挿です。進行は一定とは限りません',
  };
}

// ---------------------------------------------------------------- 測点と保存

export function createStation({ name, member = '', note = '', thresholdMM = null }) {
  if (!name || !String(name).trim()) throw new Error('測点の名前を入れてください');
  return {
    id: `st-${Math.random().toString(36).slice(2, 10)}`,
    name: String(name).trim(),
    member: String(member).trim(),
    note: String(note).trim(),
    thresholdMM: Number.isFinite(thresholdMM) ? thresholdMM : null,
    observations: [],
  };
}

/**
 * 観測を1回ぶん足す。日時順に保たれる。
 *
 * valueMM は測点の「量」。き裂を挟む2点間距離でも、絶対幅でもかまいませんが、
 * **測点内で混ぜないこと**。混ぜると差がそのまま意味を失います。
 */
export function addObservation(station, observation) {
  const at = toTime(observation.at ?? Date.now());
  if (!Number.isFinite(at)) throw new Error('日時が読めません');
  if (!Number.isFinite(observation.valueMM)) throw new Error('計測値が数値ではありません');

  const record = {
    at: new Date(at).toISOString(),
    valueMM: observation.valueMM,
    pairSigmaMM: Number.isFinite(observation.pairSigmaMM) ? observation.pairSigmaMM : null,
    temperatureC: Number.isFinite(observation.temperatureC) ? observation.temperatureC : null,
    weather: observation.weather ?? '',
    method: observation.method ?? '',
    frames: Number.isFinite(observation.frames) ? observation.frames : null,
    bulgeMM: Number.isFinite(observation.bulgeMM) ? observation.bulgeMM : null,
    note: observation.note ?? '',
  };

  const next = { ...station, observations: [...station.observations, record] };
  next.observations.sort((a, b) => toTime(a.at) - toTime(b.at));
  return next;
}

/**
 * 直近2回の比較。観測が1回以下なら null。
 * trend を渡すと温度で説明できるぶんを差し引いてから判定する。
 */
export function latestComparison(station, k = 3, trend = null) {
  const obs = station?.observations ?? [];
  if (obs.length < 2) return null;
  const before = obs[obs.length - 2];
  const after = obs[obs.length - 1];
  const result = compareEpochsWithTemperature(before, after, trend, k);
  return result ? { ...result, before, after } : null;
}

/** 初回からの比較。長期の累積を見るときはこちら。 */
export function cumulativeComparison(station, k = 3, trend = null) {
  const obs = station?.observations ?? [];
  if (obs.length < 2) return null;
  const result = compareEpochsWithTemperature(obs[0], obs[obs.length - 1], trend, k);
  return result ? { ...result, before: obs[0], after: obs[obs.length - 1] } : null;
}

const FORMAT = 'crack-tracking/history';
const VERSION = 1;

export function serialize(stations) {
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    savedAt: new Date().toISOString(),
    stations,
  }, null, 2);
}

export function deserialize(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('JSON として読めません');
  }
  if (data?.format !== FORMAT) throw new Error('このツールが書き出したファイルではありません');
  if (!Array.isArray(data.stations)) throw new Error('測点がありません');

  // 版が上がったときにここで移行する。今は 1 だけ
  if (data.version > VERSION) {
    throw new Error(`新しい版のファイルです（v${data.version}）。ツールを更新してください`);
  }
  return data.stations.map((s) => ({
    ...s,
    observations: [...(s.observations ?? [])].sort((a, b) => toTime(a.at) - toTime(b.at)),
  }));
}

export function toCSV(stations) {
  const header = [
    '測点', '部材', '日時', '計測値(mm)', 'σ_pair(mm)', '検出限界3σ(mm)',
    '前回差(mm)', '前回差の限界(mm)', '有意', '気温(C)', '天候', '方式', '枚数', 'はらみ出し(mm)', '備考',
  ];
  const rows = [header];

  for (const station of stations) {
    // 画面と同じく温度分離を効かせる。効かせないと、画面では「有意差なし」なのに
    // 帳票だけ「有意」と書かれる（夏冬交互に測ると必ず起きる）
    const trend = fitTrend(station.observations);
    station.observations.forEach((o, i) => {
      const prev = i > 0 ? station.observations[i - 1] : null;
      const cmp = prev ? compareEpochsWithTemperature(prev, o, trend) : null;
      rows.push([
        station.name, station.member, o.at,
        fmt(o.valueMM, 4),
        fmt(o.pairSigmaMM, 4),
        o.pairSigmaMM != null ? fmt(3 * o.pairSigmaMM, 4) : '',
        cmp ? fmt(cmp.deltaMM, 4) : '',
        cmp?.limitMM != null ? fmt(cmp.limitMM, 4) : '',
        cmp?.significant == null ? '' : (cmp.significant ? '有意' : '有意でない'),
        fmt(o.temperatureC, 1),
        o.weather, o.method,
        o.frames ?? '',
        fmt(o.bulgeMM, 1),
        o.note,
      ]);
    });
  }

  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmt(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits) : '';
}

function toTime(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? NaN : t;
}
