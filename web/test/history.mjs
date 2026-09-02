// 経時管理の検証。既知の傾き・既知の温度係数を仕込んで、それを当てられるか見る。

import {
  compareEpochs, compareEpochsWithTemperature, fitTrend, temperatureAdjusted, yearsToThreshold,
  createStation, addObservation, latestComparison, cumulativeComparison,
  serialize, deserialize, toCSV, tCritical95,
} from '../src/history.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 平均0・分散1 に近い乱数（一様の和で正規に寄せる） */
function gauss(rnd) {
  let s = 0;
  for (let i = 0; i < 12; i += 1) s += rnd();
  return s - 6;
}

const YEAR = 365.2425 * 86400000;
const T0 = Date.parse('2020-04-01T10:00:00Z');

/**
 * 既知の傾きと温度係数で系列を作る。
 * value = base + perYear·t + perKelvin·(T - 15) + noise
 */
function makeSeries({
  n = 8, perYear = 0.05, perKelvin = 0, base = 1.0,
  noise = 0.01, seed = 1, temps = null,
} = {}) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const years = i * (1 / 2);                       // 半年おき
    const temperatureC = temps ? temps[i % temps.length] : 15;
    out.push({
      at: new Date(T0 + years * YEAR).toISOString(),
      valueMM: base + perYear * years + perKelvin * (temperatureC - 15) + gauss(rnd) * noise,
      pairSigmaMM: noise,
      temperatureC,
    });
  }
  return out;
}

export function runHistoryTests(check, near) {
  console.log('\n== 2時期の比較 ==');
  {
    // 両日とも σ_pair = 0.03mm。片方だけの 3σ は 0.09 だが、
    // 差の限界は √2 倍の 0.127。この間に入る変化を有意と言ってはいけない
    const before = { valueMM: 1.000, pairSigmaMM: 0.03 };
    const after = { valueMM: 1.100, pairSigmaMM: 0.03 };
    const c = compareEpochs(before, after);

    check('差', near(c.deltaMM, 0.100, 1e-9), `${c.deltaMM.toFixed(4)} mm`);
    check('差の限界は片方の 3σ の √2 倍',
      near(c.limitMM, 3 * 0.03 * Math.SQRT2, 1e-9),
      `${c.limitMM.toFixed(4)} mm（片方だけなら ${(3 * 0.03).toFixed(4)}）`);
    check('片方の 3σ は超えるが差の限界は超えない → 有意でない',
      c.significant === false, `比 ${c.ratio.toFixed(3)}`);

    const bigger = compareEpochs(before, { valueMM: 1.200, pairSigmaMM: 0.03 });
    check('0.200mm なら有意', bigger.significant === true, `比 ${bigger.ratio.toFixed(3)}`);

    // 精度が違う日どうし
    const mixed = compareEpochs({ valueMM: 1.0, pairSigmaMM: 0.02 }, { valueMM: 1.3, pairSigmaMM: 0.08 });
    check('精度の違う2日は悪い方に引きずられる',
      near(mixed.limitMM, 3 * Math.hypot(0.02, 0.08), 1e-9), `${mixed.limitMM.toFixed(4)} mm`);

    const noSigma = compareEpochs({ valueMM: 1.0, pairSigmaMM: null }, { valueMM: 1.3, pairSigmaMM: 0.03 });
    check('σ が無ければ判定しない（差だけ返す）',
      noSigma.significant === null && near(noSigma.deltaMM, 0.3, 1e-9));
    // σ=0 は「測れていない」。通すと限界 0・比 null のまま「有意」になり表示で落ちる
    const zeroSigma = compareEpochs({ valueMM: 1.0, pairSigmaMM: 0 }, { valueMM: 1.3, pairSigmaMM: 0 });
    check('σ が 0 でも判定しない（有意・比 null で落ちない）',
      zeroSigma.significant === null && zeroSigma.ratio === null);
  }

  console.log('\n== 経年変化の傾き ==');
  {
    // 0.050 mm/年、ノイズ 0.004mm、4年ぶん8回
    const obs = makeSeries({ n: 8, perYear: 0.050, noise: 0.004, seed: 3 });
    const t = fitTrend(obs);
    check('傾きを復元', near(t.perYearMM, 0.050, 0.004), `${t.perYearMM.toFixed(4)} mm/年`);
    check('有意と判定', t.significant === true,
      `95%CI [${t.perYearCI[0].toFixed(4)}, ${t.perYearCI[1].toFixed(4)}]`);
    check('残差が真のノイズと一致', near(t.residualSigmaMM, 0.004, 0.002), `${t.residualSigmaMM.toFixed(4)} mm`);
    check('観測期間', near(t.spanYears, 3.5, 0.01), `${t.spanYears.toFixed(2)} 年`);

    // 1つの種で当てられたかより、信頼区間が主張どおり効いているかの方が大事。
    // 「95%CI」と書く以上、真値をその割合で含んでいなければ嘘になる
    let covered = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const r = fitTrend(makeSeries({ n: 8, perYear: 0.050, noise: 0.010, seed }));
      if (r.perYearCI[0] <= 0.050 && 0.050 <= r.perYearCI[1]) covered += 1;
    }
    check('95%信頼区間が真値を主張どおり含む', covered >= 36, `${covered} / 40`);
  }

  console.log('\n== 動いていない測点を「進行中」と言わない ==');
  {
    // 傾き 0、ノイズだけ。これを有意と言ったら偽陽性
    let falsePositives = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const t = fitTrend(makeSeries({ n: 8, perYear: 0, noise: 0.010, seed }));
      if (t.significant) falsePositives += 1;
    }
    check('偽陽性が 95% 水準どおり（40件中 5件以下）',
      falsePositives <= 5, `${falsePositives} / 40`);
  }

  console.log('\n== 温度による見かけの開閉を分離する ==');
  {
    // 実際には進行していない（0 mm/年）が、冬に冷えて開く測点。
    // 温度を無視すると、たまたま冬に多く測った系列で偽の傾きが出る
    const temps = [22, 5, 24, 3, 26, 2, 25, 4, 23, 6];
    const obs = makeSeries({
      n: 10, perYear: 0, perKelvin: -0.004, noise: 0.004, seed: 7, temps,
    });

    const naive = fitTrend(obs, { separateTemperature: false });
    const separated = fitTrend(obs, { separateTemperature: true });

    check('温度係数を復元', near(separated.perKelvinMM, -0.004, 0.0012),
      `${separated.perKelvinMM.toFixed(5)} mm/K`);
    check('温度係数が有意', separated.perKelvinSignificant === true);
    check('分離すると傾きは 0 のまま', separated.significant === false,
      `${separated.perYearMM.toFixed(4)} mm/年 CI [${separated.perYearCI[0].toFixed(4)}, ${separated.perYearCI[1].toFixed(4)}]`);
    check('分離すると残差が小さくなる',
      separated.residualSigmaMM < naive.residualSigmaMM,
      `分離 ${separated.residualSigmaMM.toFixed(4)} / 無視 ${naive.residualSigmaMM.toFixed(4)} mm`);

    const adjusted = temperatureAdjusted(obs, separated);
    const spreadRaw = spread(obs.map((o) => o.valueMM));
    const spreadAdj = spread(adjusted.map((o) => o.adjustedMM));
    check('温度補正後の系列はばらつきが減る', spreadAdj < spreadRaw * 0.6,
      `${spreadAdj.toFixed(4)} < ${spreadRaw.toFixed(4)} mm`);
  }

  console.log('\n== 温度と進行が同時にある場合 ==');
  {
    const temps = [21, 4, 23, 3, 25, 2, 24, 5, 22, 6];
    const obs = makeSeries({
      n: 10, perYear: 0.040, perKelvin: -0.004, noise: 0.004, seed: 11, temps,
    });
    const t = fitTrend(obs);
    check('温度を分離した上で進行を検出', t.significant === true,
      `${t.perYearMM.toFixed(4)} mm/年`);
    check('進行の量が正しい', near(t.perYearMM, 0.040, 0.006), `${t.perYearMM.toFixed(4)} mm/年`);
    check('温度係数も同時に出る', near(t.perKelvinMM, -0.004, 0.0012),
      `${t.perKelvinMM.toFixed(5)} mm/K`);
    check('温度が揃っていれば自動で分離する', t.temperatureSeparated === true);
  }

  console.log('\n== 前回比較にも温度分離を効かせる ==');
  {
    // 進行 0、温度で ±0.09mm 揺れる測点を夏冬交互に測った系列。
    // 温度を見ないと**毎回「有意な変化」**と出てしまう
    const temps = [26, 5, 27, 4, 25, 6];
    const rnd = mulberry32(23);
    const obs = [];
    for (let i = 0; i < 6; i += 1) {
      obs.push({
        at: new Date(T0 + i * 0.5 * YEAR).toISOString(),
        valueMM: 1.040 - 0.004 * (temps[i] - 15) + gauss(rnd) * 0.003,
        pairSigmaMM: 0.008,
        temperatureC: temps[i],
      });
    }
    const station = { observations: obs };
    const trend = fitTrend(obs);

    const naive = latestComparison(station, 3);
    check('温度を見ないと有意と出てしまう', naive.significant === true,
      `${naive.deltaMM.toFixed(4)} mm / 限界 ${naive.limitMM.toFixed(4)}`);

    const aware = latestComparison(station, 3, trend);
    check('温度を差し引くと有意でなくなる', aware.significant === false,
      `残り ${aware.deltaMM.toFixed(4)} mm / 限界 ${aware.limitMM.toFixed(4)}`);
    check('生の差も残す', near(aware.rawDeltaMM, naive.deltaMM, 1e-9),
      `${aware.rawDeltaMM.toFixed(4)} mm`);
    check('温度で説明できた量を出す',
      near(aware.temperatureExplainedMM, -0.004 * aware.deltaTemperatureK, 0.006),
      `${aware.temperatureExplainedMM.toFixed(4)} mm（ΔT=${aware.deltaTemperatureK}K）`);
    check('温度係数の不確かさぶん限界が広がる', aware.limitMM > naive.limitMM,
      `${aware.limitMM.toFixed(4)} > ${naive.limitMM.toFixed(4)} mm`);

    // 本当に進行している場合は、温度を差し引いても残る（0.2mm/年）
    const moving = obs.map((o, i) => ({ ...o, valueMM: o.valueMM + 0.2 * i * 0.5 }));
    const movingTrend = fitTrend(moving);
    const movingCmp = latestComparison({ observations: moving }, 3, movingTrend);
    check('本物の進行は温度を引いても残る', movingCmp.significant === true,
      `残り ${movingCmp.deltaMM.toFixed(4)} mm / 限界 ${movingCmp.limitMM.toFixed(4)}`);

    // 温度係数が有意でないときは差し引かない（推定の当てはめすぎを防ぐ）
    const noTempTrend = fitTrend(obs, { separateTemperature: false });
    const untouched = compareEpochsWithTemperature(obs[4], obs[5], noTempTrend);
    check('温度係数が使えないときは差し引かない',
      untouched.temperatureAdjusted === undefined, `${untouched.deltaMM.toFixed(4)} mm`);
  }

  console.log('\n== 観測が少ないとき ==');
  {
    const two = fitTrend(makeSeries({ n: 2 }));
    check('2回では傾きを出さない', two.ok === false, two.reason);

    // 3回・温度あり → 説明変数3本で自由度0。温度分離は諦めるべき
    const three = fitTrend(makeSeries({ n: 3, temps: [10, 20, 30] }), { separateTemperature: true });
    check('自由度が足りなければ回帰しない', three.ok === false, three.reason);

    const threeNoTemp = fitTrend(makeSeries({ n: 3, perYear: 0.05, noise: 0.001, seed: 2 }),
      { separateTemperature: false });
    check('3回・温度なしなら傾きは出る', threeNoTemp.ok === true,
      `${threeNoTemp.perYearMM.toFixed(4)} mm/年 dof=${threeNoTemp.dof}`);

    // 少ない回数では t 値が大きく、簡単には有意にならない
    check('自由度1の t 値は 12.7', near(tCritical95(1), 12.706, 1e-3));
    check('自由度が増えると 1.96 へ近づく', near(tCritical95(200), 1.96, 1e-9));
  }

  console.log('\n== しきい値到達の外挿 ==');
  {
    const t = fitTrend(makeSeries({ n: 8, perYear: 0.050, noise: 0.008, seed: 5 }));
    const reach = yearsToThreshold(t, 1.0, 1.5);
    check('到達年数', near(reach.years, 0.5 / t.perYearMM, 1e-6), `${reach.years.toFixed(1)} 年`);
    check('早い側 < 点推定 < 遅い側',
      reach.fastestYears < reach.years && reach.years < reach.slowestYears,
      `${reach.fastestYears.toFixed(1)} 〜 ${reach.slowestYears.toFixed(1)} 年`);
    check('外挿である旨が付く', /外挿/.test(reach.note));

    const flat = fitTrend(makeSeries({ n: 8, perYear: 0, noise: 0.010, seed: 9 }));
    check('傾きが有意でなければ外挿しない', yearsToThreshold(flat, 1.0, 1.5) === null);

    const passed = yearsToThreshold(t, 1.6, 1.5);
    check('既に超えていれば 0', passed.years === 0, passed.note);
  }

  console.log('\n== 測点 ==');
  {
    let st = createStation({ name: 'A-1 橋台west面', member: '橋台', thresholdMM: 2.0 });
    check('測点が作れる', st.name === 'A-1 橋台west面' && st.observations.length === 0);

    let threw = false;
    try { createStation({ name: '  ' }); } catch { threw = true; }
    check('名前が空なら弾く', threw);

    // わざと順番を入れ替えて足す
    st = addObservation(st, { at: '2024-06-01T10:00:00Z', valueMM: 1.10, pairSigmaMM: 0.03, temperatureC: 24 });
    st = addObservation(st, { at: '2023-06-01T10:00:00Z', valueMM: 1.00, pairSigmaMM: 0.03, temperatureC: 23 });
    st = addObservation(st, { at: '2025-06-01T10:00:00Z', valueMM: 1.30, pairSigmaMM: 0.03, temperatureC: 25 });

    check('日時順に並ぶ',
      st.observations.map((o) => o.at.slice(0, 4)).join(',') === '2023,2024,2025',
      st.observations.map((o) => o.at.slice(0, 10)).join(' '));

    const latest = latestComparison(st);
    check('直近2回の差', near(latest.deltaMM, 0.20, 1e-9), `${latest.deltaMM.toFixed(3)} mm`);
    check('直近2回は有意', latest.significant === true, `比 ${latest.ratio.toFixed(2)}`);

    const cum = cumulativeComparison(st);
    check('初回からの累積', near(cum.deltaMM, 0.30, 1e-9), `${cum.deltaMM.toFixed(3)} mm`);

    let badValue = false;
    try { addObservation(st, { at: '2025-01-01', valueMM: 'x' }); } catch { badValue = true; }
    check('数値でない計測値を弾く', badValue);

    let badDate = false;
    try { addObservation(st, { at: 'きのう', valueMM: 1 }); } catch { badDate = true; }
    check('読めない日時を弾く', badDate);

    check('観測1回では比較しない', latestComparison(createStation({ name: 'x' })) === null);
  }

  console.log('\n== 保存と書き出し ==');
  {
    let st = createStation({ name: 'B-2', member: '橋台', note: 'ミソ際' });
    st = addObservation(st, { at: '2024-01-05T09:00:00Z', valueMM: 0.8, pairSigmaMM: 0.02, temperatureC: 3, weather: '曇' });
    st = addObservation(st, { at: '2024-08-05T09:00:00Z', valueMM: 0.95, pairSigmaMM: 0.02, temperatureC: 28, weather: '晴' });

    const json = serialize([st]);
    const back = deserialize(json);
    check('往復して同じ', JSON.stringify(back) === JSON.stringify([st]));

    let wrongFormat = false;
    try { deserialize('{"format":"other","stations":[]}'); } catch { wrongFormat = true; }
    check('別形式を弾く', wrongFormat);

    let futureVersion = false;
    try { deserialize('{"format":"crack-tracking/history","version":99,"stations":[]}'); } catch (e) {
      futureVersion = /新しい版/.test(e.message);
    }
    check('未来の版を弾く', futureVersion);

    let notJson = false;
    try { deserialize('これは JSON ではない'); } catch { notJson = true; }
    check('JSON でないものを弾く', notJson);

    const csv = toCSV([st]);
    const lines = csv.split('\r\n');
    check('CSV の行数', lines.length === 3, `${lines.length} 行`);
    check('CSV に前回差が入る', lines[2].includes('0.1500'), lines[2]);
    check('CSV の1行目は空（初回は前回差なし）',
      lines[1].split(',')[6] === '', `「${lines[1].split(',')[6]}」`);

    // 区切り文字を含む値が壊れないこと
    let quoted = createStation({ name: 'C,3' });
    quoted = addObservation(quoted, { at: '2024-01-01T00:00:00Z', valueMM: 1, note: '引用"あり"' });
    const qcsv = toCSV([quoted]);
    check('カンマと引用符を退避', qcsv.includes('"C,3"') && qcsv.includes('"引用""あり"""'));
  }
}

function spread(values) {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}
