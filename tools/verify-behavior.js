/* 教学行为验证：四个特殊批次必须在真实计算下表现出设计性质。
   同时核对标准化、LBO 真实重拟合、降秩检测、分组 CV 的正确性。 */
'use strict';
const S = require('../js/stats.js');
const sample = require('../js/sample-data.js').Sample;
const rows = sample.rows;

// ---- 设计矩阵：截距 + z(温度) + z(速度) + C2 + C3 ----
function designBuilder(trainRows) {
  const tMean = S.mean(trainRows.map(r => r.temperature));
  const sMean = S.mean(trainRows.map(r => r.speed));
  const tSd = Math.sqrt(S.variance(trainRows.map(r => r.temperature)) / trainRows.length);
  const sSd = Math.sqrt(S.variance(trainRows.map(r => r.speed)) / trainRows.length);
  return {
    params: { tMean, tSd, sMean, sSd },
    x(r) {
      return [
        1,
        (r.temperature - tMean) / tSd,
        (r.speed - sMean) / sSd,
        r.condition === 'C2' ? 1 : 0,
        r.condition === 'C3' ? 1 : 0
      ];
    }
  };
}
const NAMES = ['截距', '温度 z', '速度 z', 'C2(高湿)', 'C3(低温)'];

function fitOn(subset, method) {
  const d = designBuilder(subset);
  const X = subset.map(d.x), y = subset.map(r => r.loss);
  const fit = method === 'huber' ? S.huber(X, y) : S.ols(X, y);
  return { fit, d, X, y };
}

const full = fitOn(rows, 'ols');
const robust = fitOn(rows, 'huber');
console.log('== 全量 OLS 系数（标准化空间）==');
full.fit.beta.forEach((b, j) => console.log(`  ${NAMES[j].padEnd(10)} ${b.toFixed(4)}  se=${full.fit.se[j].toFixed(4)}`));
console.log('  sigma =', full.fit.sigma.toFixed(4), ' rank =', full.fit.rank, '/', full.fit.m);
console.log('== Huber 系数 ==');
robust.fit.beta.forEach((b, j) => console.log(`  ${NAMES[j].padEnd(10)} ${b.toFixed(4)}  (OLS ${full.fit.beta[j].toFixed(4)})`));
console.log('  robust scale =', robust.fit.scale.toFixed(4), ' iter =', robust.fit.iterations, ' 最小权重 =', Math.min(...robust.fit.weights).toFixed(3));

// ---- 诊断 ----
const groups = rows.map(r => r.batch);
const diag = S.diagnostics(full.fit, rows.map(r => r.loss), groups);
const byBatch = {};
for (const r of rows) (byBatch[r.batch] ||= []).push(r);

function summarize(batchId) {
  const idx = rows.map((r, i) => r.batch === batchId ? i : -1).filter(i => i >= 0);
  const pts = idx.map(i => diag[i]);
  return {
    n: pts.length,
    maxAbsStud: Math.max(...pts.map(p => Math.abs(p.studResid))),
    meanResid: S.mean(pts.map(p => p.resid)),
    maxLeverage: Math.max(...pts.map(p => p.leverage)),
    maxCooks: Math.max(...pts.map(p => p.cooksD)),
    minHuberW: Math.min(...idx.map(i => robust.fit.weights[i]))
  };
}
console.log('\n== 批次诊断摘要 ==');
console.log('batch      max|stud|  meanResid  maxLever  maxCookD  minHuberW');
for (const b of Object.keys(byBatch)) {
  const z = summarize(b);
  console.log(
    `${b.padEnd(10)} ${z.maxAbsStud.toFixed(2).padStart(8)}  ${z.meanResid.toFixed(3).padStart(8)}  ` +
    `${z.maxLeverage.toFixed(3).padStart(7)}  ${z.maxCooks.toFixed(3).padStart(7)}  ${z.minHuberW.toFixed(3).padStart(8)}`
  );
}

// ---- LBO 真实重拟合 ----
console.log('\n== 整批删除后真实重拟合（OLS）==');
const lbo = {};
for (const b of Object.keys(byBatch)) {
  const rest = rows.filter(r => r.batch !== b);
  const { fit } = fitOn(rest, 'ols');
  lbo[b] = fit;
  const dT = fit.fullRank ? fit.beta[1] - full.fit.beta[1] : null;
  const dS = fit.fullRank ? fit.beta[2] - full.fit.beta[2] : null;
  console.log(
    `删 ${b.padEnd(8)} rank=${fit.rank}/${fit.m}  Δ温度=${dT === null ? '  N/A ' : dT.toFixed(4)}  Δ速度=${dS === null ? ' N/A ' : dS.toFixed(4)}`
  );
}

// ---- 教学断言 ----
const hl = summarize('B-HL'), out = summarize('B-OUT'), sh = summarize('B-SHIFT'), rk = lbo['B-RANK'];
const avgLeverage = full.fit.m / full.fit.n;
const assert = (cond, msg) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
console.log('\n== 教学断言 ==');
assert(hl.maxLeverage > 3 * avgLeverage, `B-HL 高杠杆 (${hl.maxLeverage.toFixed(3)} > 3·平均 ${(3 * avgLeverage).toFixed(3)})`);
assert(hl.maxAbsStud < 2.0, `B-HL 残差小、不触发单点异常 (max|stud|=${hl.maxAbsStud.toFixed(2)} < 2)`);
assert(Math.abs(lbo['B-HL'].beta[1] - full.fit.beta[1]) > 0.15,
  `B-HL 删除后温度系数大幅变化 (Δ=${(lbo['B-HL'].beta[1] - full.fit.beta[1]).toFixed(3)})`);
assert(!rk.fullRank && rk.rank < rk.m, `B-RANK 删除后降秩 (rank=${rk.rank}/${rk.m})`);
assert(out.maxAbsStud > 3.0, `B-OUT 单条异常 (max|stud|=${out.maxAbsStud.toFixed(2)} > 3)`);
assert(Math.abs(lbo['B-OUT'].beta[1] - full.fit.beta[1]) < 0.06,
  `B-OUT 删除对系数影响小 (Δ温度=${(lbo['B-OUT'].beta[1] - full.fit.beta[1]).toFixed(3)})`);
assert(sh.maxAbsStud < 3.0, `B-SHIFT 单条不触发异常阈值 |stud|>3 (max|stud|=${sh.maxAbsStud.toFixed(2)})`);
assert(Math.abs(sh.meanResid) > 0.8, `B-SHIFT 批次平均残差大 (${sh.meanResid.toFixed(3)})`);
assert(sh.minHuberW < 0.75, `B-SHIFT 被 Huber 降权 (minW=${sh.minHuberW.toFixed(3)} < 0.75)`);
// 关键教学结论：Huber 对 B-HL 几乎不降权（小残差高杠杆），对 B-OUT/B-SHIFT 才降权
assert(Math.min(...rows.map((r, i) => r.batch === 'B-HL' ? robust.fit.weights[i] : 1)) > 0.95,
  `Huber 对高杠杆 B-HL 几乎不降权 (minW=${Math.min(...rows.map((r, i) => r.batch === 'B-HL' ? robust.fit.weights[i] : 1)).toFixed(3)})`);
assert(Math.abs(robust.fit.beta[3] - full.fit.beta[3]) > 0.05,
  `稳健与 OLS 工况系数有可见差异 (ΔC2=${(robust.fit.beta[3] - full.fit.beta[3]).toFixed(3)})`);

// Huber 在降秩输入下应安全返回 fullRank=false，而不是崩溃
const rankRows = rows.filter(r => r.batch !== 'B-RANK');
const rankBuilt = designBuilder(rankRows);
const hubRank = S.huber(rankRows.map(rankBuilt.x), rankRows.map(r => r.loss));
assert(!hubRank.fullRank, 'Huber 遇降秩设计安全返回 fullRank=false');

// ---- 分组 CV ----
const { makeRng } = require('../js/rng.js');
const cvOls = S.groupedKFold(rows, 5, makeRng(7), (X, y) => S.ols(X, y), designBuilder);
const cvHub = S.groupedKFold(rows, 5, makeRng(7), (X, y) => S.huber(X, y), designBuilder);
console.log('\n== 5 折批次分组 CV（同折分配）==');
console.log('每折状态:');
cvOls.foldErr.forEach((e, i) => {
  const tag = e.rankDeficient ? '降秩跳过（该折含唯一 C3 批次）' :
    `RMSE=${e.rmse.toFixed(3)} MAE=${e.mae.toFixed(3)} groups=${e.groups.join(',')}`;
  console.log(`  fold ${i}: n=${e.nTest} ${tag}`);
});
console.log('OLS   pooled RMSE =', cvOls.pooled.rmse === null ? 'N/A（有折降秩）' : cvOls.pooled.rmse.toFixed(4),
  ' MAE =', cvOls.pooled.mae === null ? 'N/A' : cvOls.pooled.mae.toFixed(4));
console.log('Huber pooled RMSE =', cvHub.pooled.rmse === null ? 'N/A（有折降秩）' : cvHub.pooled.rmse.toFixed(4),
  ' MAE =', cvHub.pooled.mae === null ? 'N/A' : cvHub.pooled.mae.toFixed(4));

// ---- 物理单位反变换检查（温度每 +1°C 的损耗变化）----
const physT = full.fit.beta[1] / full.d.params.tSd;
console.log('\n温度系数（物理单位 %/°C）OLS =', physT.toFixed(4), ' 真实 0.12（被 B-HL 拉偏预期偏高）');
const physTHub = robust.fit.beta[1] / robust.d.params.tSd;
console.log('温度系数（物理单位 %/°C）Huber =', physTHub.toFixed(4));
