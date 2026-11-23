/* 分析流水线：设计矩阵、只由训练批次估计的标准化参数、OLS/Huber 拟合、
   整批删除真实重拟合、业务预测（含外推判定）、批次级诊断汇总。
   纯逻辑、无 DOM，UMD 可在 Node 下测试。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./stats.js'));
  } else {
    root.PRA = root.PRA || {};
    root.PRA.Pipeline = factory(root.PRA.Stats);
  }
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  const COEF_LABELS = ['截距', '温度（标准化）', '速度（标准化）', '工况 C2 高湿', '工况 C3 低温'];
  const PHYS_LABELS = ['截距 %', '温度 %/°C', '速度 %/(m·min⁻¹)', 'C2 偏移 %', 'C3 偏移 %'];

  /* 标准化参数只由传入的训练行估计（总体标准差，与页面口径一致）。 */
  function makeDesign(trainRows) {
    const tVals = trainRows.map(r => r.temperature);
    const sVals = trainRows.map(r => r.speed);
    const tMean = S.mean(tVals), sMean = S.mean(sVals);
    const tSd = Math.sqrt(S.variance(tVals) / tVals.length);
    const sSd = Math.sqrt(S.variance(sVals) / sVals.length);
    return {
      scaling: { tMean, tSd, sMean, sSd },
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

  /* 在给定行集上完整拟合一套模型。method: 'ols' | 'huber'。 */
  function fitModel(rows, method) {
    const design = makeDesign(rows);
    const X = rows.map(design.x);
    const y = rows.map(r => r.loss);
    const fit = method === 'huber' ? S.huber(X, y) : S.ols(X, y);
    return { rows, design, X, y, fit, method };
  }

  /* 物理单位系数：beta_z / sd。仅满秩时有意义。 */
  function physicalCoefficients(model) {
    if (!model.fit.fullRank) return COEF_LABELS.map(() => null);
    const b = model.fit.beta;
    const { tSd, sSd } = model.design.scaling;
    return [b[0], b[1] / tSd, b[2] / sSd, b[3], b[4]];
  }

  function physicalSE(model) {
    if (!model.fit.fullRank || !model.fit.se) return COEF_LABELS.map(() => null);
    const se = model.fit.se;
    const { tSd, sSd } = model.design.scaling;
    return [se[0], se[1] / tSd, se[2] / sSd, se[3], se[4]];
  }

  function predict(model, point) {
    if (!model.fit.fullRank) return { value: null, inDomain: null, reasons: ['模型降秩，无法预测'] };
    const xr = model.design.x(point);
    let value = 0;
    for (let j = 0; j < xr.length; j++) value += model.fit.beta[j] * xr[j];
    const cover = coverage(model.rows, point);
    return { value, ...cover };
  }

  /* 业务预测范围判定：温度/速度是否落在训练批次覆盖的凸包（矩形）内，
     以及该工况在训练批次中是否仍有样本。 */
  function coverage(trainRows, point) {
    const reasons = [];
    const tMin = Math.min(...trainRows.map(r => r.temperature));
    const tMax = Math.max(...trainRows.map(r => r.temperature));
    const sMin = Math.min(...trainRows.map(r => r.speed));
    const sMax = Math.max(...trainRows.map(r => r.speed));
    if (point.temperature < tMin || point.temperature > tMax)
      reasons.push(`温度 ${fmt(point.temperature, 2)}°C 超出训练范围 [${fmt(tMin, 1)}, ${fmt(tMax, 1)}]`);
    if (point.speed < sMin || point.speed > sMax)
      reasons.push(`速度 ${fmt(point.speed, 1)} 超出训练范围 [${fmt(sMin, 1)}, ${fmt(sMax, 1)}]`);
    const condRows = trainRows.filter(r => r.condition === point.condition);
    if (!condRows.length)
      reasons.push(`工况 ${point.condition} 在训练批次中已无任何样本`);
    return {
      inDomain: reasons.length === 0,
      reasons,
      domain: { tMin, tMax, sMin, sMax },
      conditionCovered: condRows.length > 0
    };
  }

  /* 整批删除：真实重新执行完整流水线（重新标准化、重新 QR/IRLS），
     不是单点影响近似。 */
  function leaveBatchOut(fullModel, batchId, method) {
    const rest = fullModel.rows.filter(r => r.batch !== batchId);
    const removed = fullModel.rows.filter(r => r.batch === batchId);
    const model = fitModel(rest, method);
    const coverIssues = [];
    for (const c of Array.from(new Set(removed.map(r => r.condition)))) {
      if (!rest.some(r => r.condition === c)) coverIssues.push(`工况 ${c} 删除后无覆盖`);
    }
    return {
      batchId,
      model,
      removed,
      rankDeficient: !model.fit.fullRank,
      coverIssues,
      // 被排除批次作为留出数据的真实预测误差（模型完全没见过它）
      heldOut: model.fit.fullRank ? evalHeldOut(model, removed) : null
    };
  }

  function evalHeldOut(model, rows) {
    if (!rows.length) return null;
    const y = rows.map(r => r.loss);
    const yhat = rows.map(r => predict(model, r).value);
    return { n: rows.length, rmse: S.rmse(y, yhat), mae: S.mae(y, yhat) };
  }

  /* 全批次 LBO 扫描：用于“批次影响总览”图——全部为真实重拟合结果。 */
  function lboScan(fullModel, method) {
    const batches = Array.from(new Set(fullModel.rows.map(r => r.batch)));
    return batches.map(b => {
      const lbo = leaveBatchOut(fullModel, b, method);
      const deltas = fullModel.fit.fullRank && lbo.model.fit.fullRank
        ? fullModel.fit.beta.map((v, j) => lbo.model.fit.beta[j] - v)
        : null;
      return {
        batch: b,
        nRemoved: lbo.removed.length,
        rankDeficient: lbo.rankDeficient,
        coverIssues: lbo.coverIssues,
        deltas,
        heldOut: lbo.heldOut
      };
    });
  }

  /* 批次级诊断：把单点诊断聚合为批次结论。 */
  function batchDiagnostics(fullModel, pointDiag) {
    const rows = fullModel.rows;
    const byBatch = new Map();
    pointDiag.forEach((d, i) => {
      const r = rows[i];
      if (!byBatch.has(r.batch)) {
        byBatch.set(r.batch, {
          batch: r.batch, source: r.source, condition: r.condition,
          role: r.role || null, indices: [], n: 0
        });
      }
      const b = byBatch.get(r.batch);
      b.indices.push(i);
      b.n++;
    });
    const out = [];
    for (const b of byBatch.values()) {
      const pts = b.indices.map(i => pointDiag[i]);
      const absStud = pts.map(p => Math.abs(p.studResid));
      const meanResid = S.mean(pts.map(p => p.resid));
      const sdResid = Math.sqrt(S.variance(pts.map(p => p.resid)) / pts.length);
      const maxLeverage = Math.max(...pts.map(p => p.leverage));
      const maxCooks = Math.max(...pts.map(p => p.cooksD));
      const huberW = fullModel.huber && fullModel.huber.weights
        ? b.indices.map(i => fullModel.huber.weights[i]) : null;
      const flags = [];
      // 单条异常：批次内存在 |学生化残差| > 3 的测量，但并非整批同向
      if (Math.max(...absStud) > 3) flags.push('singleOutlier');
      // 整批偏移：平均残差显著且批次内部一致（sd 小、均值大）
      if (Math.abs(meanResid) > 1.5 * fullModel.fit.sigma && sdResid < fullModel.fit.sigma)
        flags.push('batchShift');
      // 高杠杆：批次最大杠杆超过 3 倍平均杠杆 p/n
      const avgLev = fullModel.fit.m / fullModel.fit.n;
      if (maxLeverage > 3 * avgLev) flags.push('highLeverage');
      if (maxCooks > 4 / fullModel.fit.n) flags.push('influential');
      out.push({
        ...b,
        meanResid, sdResid, maxAbsStud: Math.max(...absStud),
        maxLeverage, maxCooks,
        minHuberWeight: huberW ? Math.min(...huberW) : null,
        flags
      });
    }
    return out.sort((a, b) => b.maxCooks - a.maxCooks);
  }

  function fmt(v, d) {
    return v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d);
  }

  return {
    COEF_LABELS, PHYS_LABELS,
    makeDesign, fitModel, physicalCoefficients, physicalSE,
    predict, coverage, leaveBatchOut, lboScan, batchDiagnostics,
    evalHeldOut, fmt
  };
});
