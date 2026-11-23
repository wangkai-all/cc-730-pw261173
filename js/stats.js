/* 统计核心：带列主元 QR 的 OLS（真实数值秩检测）、Huber IRLS 稳健回归、
   单点/整批诊断、按批次分组的交叉验证。
   所有函数只做数学，不接触 DOM；UMD，可在 Node 下单测。 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.PRA = root.PRA || {};
  root.PRA.Stats = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HUBER_K = 1.345; // 标准默认调节常数（95% 正态效率），非数据驱动选择
  const RANK_TOL = 1e-10;

  // ---------- 基础线性代数 ----------

  function zeros(n, m) {
    const A = new Array(n);
    for (let i = 0; i < n; i++) A[i] = new Array(m).fill(0);
    return A;
  }

  function matT(A) {
    const n = A.length, m = A[0].length, T = zeros(m, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) T[j][i] = A[i][j];
    return T;
  }

  function matVec(A, x) {
    const n = A.length, m = A[0].length, y = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = 0; j < m; j++) s += A[i][j] * x[j];
      y[i] = s;
    }
    return y;
  }

  function vecSub(a, b) { return a.map((v, i) => v - b[i]); }
  function vecAdd(a, b) { return a.map((v, i) => v + b[i]); }
  function mean(x) { return x.reduce((s, v) => s + v, 0) / x.length; }

  function variance(x) {
    const mu = mean(x);
    return x.reduce((s, v) => s + (v - mu) * (v - mu), 0);
  }

  function mad(x) {
    const med = median(x.slice());
    const dev = x.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    return 1.4826 * median(dev);
  }

  function median(sortedAsc) {
    const n = sortedAsc.length;
    if (n === 0) return NaN;
    const mid = n >> 1;
    return n % 2 ? sortedAsc[mid] : 0.5 * (sortedAsc[mid - 1] + sortedAsc[mid]);
  }

  /* Householder QR，带列主元。
     返回 { R (p×m), Q^T y 已应用到 beta 求解路径, pivot, rank, tauDiag }。
     主元使列主元顺序与数值秩可被直接检查——这是“设计矩阵降秩”判定的来源。 */
  function qrPivot(A, y) {
    const n = A.length, m = A[0].length;
    const R = zeros(n, m);
    for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) R[i][j] = A[i][j];
    const z = y.slice();
    const pivot = Array.from({ length: m }, (_, j) => j);
    const colNorm = j => {
      let s = 0;
      for (let i = 0; i < n; i++) s += R[i][j] * R[i][j];
      return s;
    };

    const p = Math.min(n, m);
    const rDiag = [];
    let rank = 0;
    for (let k = 0; k < p; k++) {
      // 列主元：剩余列中范数最大者换到第 k 列
      let best = k;
      let bestNorm = colNorm(k);
      for (let j = k + 1; j < m; j++) {
        const nj = colNorm(j);
        if (nj > bestNorm) { bestNorm = nj; best = j; }
      }
      if (best !== k) {
        for (let i = 0; i < n; i++) [R[i][k], R[i][best]] = [R[i][best], R[i][k]];
        [pivot[k], pivot[best]] = [pivot[best], pivot[k]];
      }
      // Householder 向量
      const sigma = Math.sqrt(colNorm(k));
      rDiag.push(sigma);
      if (sigma < 1e-14) continue;
      const v = new Array(n).fill(0);
      let sgn = R[k][k] >= 0 ? 1 : -1;
      v[k] = R[k][k] + sgn * sigma;
      for (let i = k + 1; i < n; i++) v[i] = R[i][k];
      const vtv = v.reduce((s, t) => s + t * t, 0);
      if (vtv < 1e-300) continue;
      for (let j = k; j < m; j++) {
        let dot = 0;
        for (let i = k; i < n; i++) dot += v[i] * R[i][j];
        const c = 2 * dot / vtv;
        for (let i = k; i < n; i++) R[i][j] -= c * v[i];
      }
      {
        let dot = 0;
        for (let i = k; i < n; i++) dot += v[i] * z[i];
        const c = 2 * dot / vtv;
        for (let i = k; i < n; i++) z[i] -= c * v[i];
      }
    }
    const r0 = Math.max(...rDiag, 1);
    rank = rDiag.filter(d => d > RANK_TOL * r0).length;
    return { R, qty: z, pivot, rank, rDiag, p };
  }

  // 由 QR 结果回代求 beta（秩不足时仅对 rank 个主元列求解，其余置 null）
  function solveQR(qr) {
    const { R, qty, pivot, rank, p } = qr;
    const m = pivot.length;
    const betaPivot = new Array(m).fill(null);
    for (let k = rank - 1; k >= 0; k--) {
      let s = qty[k];
      for (let j = k + 1; j < rank; j++) s -= R[k][j] * betaPivot[j];
      const d = R[k][k];
      betaPivot[k] = Math.abs(d) < 1e-300 ? null : s / d;
    }
    const beta = new Array(m).fill(null);
    for (let k = 0; k < m; k++) beta[pivot[k]] = betaPivot[k];
    return beta;
  }

  // ---------- 拟合 ----------

  /* OLS。返回 beta（秩不足项为 null）、fitted、resid、rank、sigma、
     hat 矩阵对角、X'X 逆（满秩时）。 */
  function ols(X, y) {
    const n = X.length, m = X[0].length;
    const qr = qrPivot(X, y);
    const beta = solveQR(qr);
    const fullRank = qr.rank === m;
    const fitted = fullRank ? matVec(X, beta) : null;
    const resid = fullRank ? vecSub(y, fitted) : null;
    let sigma = null, se = new Array(m).fill(null), xtxInv = null;
    const hat = new Array(n).fill(null);

    if (fullRank) {
      const df = n - m;
      const rss = resid.reduce((s, r) => s + r * r, 0);
      sigma = Math.sqrt(rss / df);
      // X'X 逆：R 为上三角，(X'X)^-1 = R^-1 (R^-1)'（QR 中 X=QR，列主元已还原）
      const Rinv = zeros(m, m);
      for (let k = 0; k < m; k++) {
        Rinv[k][k] = 1 / qr.R[k][k];
        for (let i = k - 1; i >= 0; i--) {
          let s = 0;
          for (let j = i + 1; j <= k; j++) s += qr.R[i][j] * Rinv[j][k];
          Rinv[i][k] = -s / qr.R[i][i];
        }
      }
      xtxInv = zeros(m, m);
      for (let i = 0; i < m; i++)
        for (let j = 0; j < m; j++) {
          let s = 0;
          for (let k = 0; k < m; k++) s += Rinv[i][k] * Rinv[j][k];
          xtxInv[i][j] = s;
        }
      for (let j = 0; j < m; j++) se[j] = sigma * Math.sqrt(Math.max(xtxInv[j][j], 0));
      for (let i = 0; i < n; i++) {
        let h = 0;
        for (let j = 0; j < m; j++) h += X[i][j] * X[i][j] * xtxInv[j][j];
        for (let a = 0; a < m; a++)
          for (let b = 0; b < m; b++)
            if (a !== b) h += X[i][a] * X[i][b] * xtxInv[a][b];
        hat[i] = h;
      }
    }
    return { method: 'OLS', beta, fitted, resid, rank: qr.rank, fullRank, qr, sigma, se, xtxInv, hat, n, m };
  }

  /* Huber M 估计，IRLS。尺度用 MAD（仅训练数据），调节常数固定 1.345。
     以 OLS 起步；秩不足直接返回失败，由上层决定如何呈现。 */
  function huber(X, y, opts) {
    const k = (opts && opts.k) || HUBER_K;
    const maxIter = (opts && opts.maxIter) || 100;
    const tol = (opts && opts.tol) || 1e-8;
    const n = X.length, m = X[0].length;
    const start = ols(X, y);
    if (!start.fullRank) {
      return { method: 'Huber', fullRank: false, rank: start.rank, beta: new Array(m).fill(null) };
    }
    let beta = start.beta.slice();
    let scale = mad(start.resid);
    if (!(scale > 1e-12)) scale = start.sigma;
    let weights = new Array(n).fill(1);
    let iter = 0;
    for (; iter < maxIter; iter++) {
      const fitted = matVec(X, beta);
      const r = vecSub(y, fitted);
      let maxDelta = 0;
      for (let i = 0; i < n; i++) {
        const u = Math.abs(r[i]) / scale;
        weights[i] = u <= k ? 1 : k / u;
      }
      // 加权最小二乘：用平方根权重变换 X、y 后走同一套 QR
      const Xw = zeros(n, m), yw = new Array(n);
      for (let i = 0; i < n; i++) {
        const sq = Math.sqrt(weights[i]);
        for (let j = 0; j < m; j++) Xw[i][j] = X[i][j] * sq;
        yw[i] = y[i] * sq;
      }
      const wfit = ols(Xw, yw);
      if (!wfit.fullRank) {
        return { method: 'Huber', fullRank: false, rank: wfit.rank, beta: new Array(m).fill(null), weights: null };
      }
      for (let j = 0; j < m; j++) maxDelta = Math.max(maxDelta, Math.abs(wfit.beta[j] - beta[j]));
      beta = wfit.beta;
      const newScale = mad(r);
      if (newScale > 1e-12) scale = newScale;
      if (maxDelta < tol) { iter++; break; }
    }
    const fitted = matVec(X, beta);
    const resid = vecSub(y, fitted);
    // 稳健协方差（三明治估计的简化版：X'WX 逆 × X' W^2 diag(r²) X × ...），
    // 这里报告 IRLS 末轮权重加权协方差，供页面展示稳健标准误。
    const Xw = zeros(n, m), yw = new Array(n);
    for (let i = 0; i < n; i++) {
      const sq = Math.sqrt(weights[i]);
      for (let j = 0; j < m; j++) Xw[i][j] = X[i][j] * sq;
      yw[i] = y[i] * sq;
    }
    const wfit = ols(Xw, yw);
    if (!wfit.fullRank) {
      return { method: 'Huber', fullRank: false, rank: wfit.rank, beta: new Array(m).fill(null), weights: null };
    }
    const se = wfit.se ? wfit.se.map(s => s) : new Array(m).fill(null);
    return {
      method: 'Huber', beta, fitted, resid, rank: m, fullRank: true,
      weights, scale, k, iterations: iter, se, n, m
    };
  }

  // ---------- 诊断量（基于 OLS 拟合） ----------

  function diagnostics(fit, y, groups) {
    const { resid, hat, sigma, n, m, beta, xtxInv } = fit;
    const rss = resid.reduce((s, r) => s + r * r, 0);
    const points = resid.map((r, i) => {
      const h = hat[i];
      const s_i = Math.sqrt(Math.max(rss - r * r, 1e-12) / (n - m - 1));
      const stud = Math.abs(1 - h) < 1e-12 ? 0 : (r / (s_i * Math.sqrt(Math.max(1 - h, 1e-12))));
      const cook = Math.abs(1 - h) < 1e-12 ? 0 :
        (r * r / (m * sigma * sigma)) * (h / Math.max((1 - h) * (1 - h), 1e-12));
      // DFFITS（单点影响近似——页面明确标注它不能替代整批删除重拟合）
      const dffits = Math.abs(1 - h) < 1e-12 ? 0 : stud * Math.sqrt(h / Math.max(1 - h, 1e-12));
      return { index: i, group: groups[i], resid: r, studResid: stud, leverage: h, cooksD: cook, dffits };
    });
    return points;
  }

  /* 单点 DFBETA（标准 OLS 公式）：仅用于与“真实整批删除”并列对比，
     页面会明确说明这是一阶近似。 */
  function dfbetaSingle(fit, X, y) {
    const { resid, hat, xtxInv, m } = fit;
    return resid.map((r, i) => {
      const denom = 1 - hat[i];
      const xRow = X[i];
      const coef = r / Math.max(denom, 1e-12);
      const d = new Array(m);
      for (let j = 0; j < m; j++) {
        let s = 0;
        for (let a = 0; a < m; a++) s += xtxInv[j][a] * xRow[a];
        d[j] = s * coef;
      }
      return d;
    });
  }

  function rmse(y, yhat) {
    let s = 0;
    for (let i = 0; i < y.length; i++) {
      const d = y[i] - yhat[i];
      s += d * d;
    }
    return Math.sqrt(s / y.length);
  }
  function mae(y, yhat) {
    let s = 0;
    for (let i = 0; i < y.length; i++) s += Math.abs(y[i] - yhat[i]);
    return s / y.length;
  }

  /* 按批次分组的 K 折交叉验证。
     关键约束：标准化参数与稳健方案的尺度/权重只在训练折的批次上估计，
     验证折整批不参与任何拟合参数。fitBuilder(Xtr, ytr) 返回 {beta,...}。 */
  function groupedKFold(rows, folds, rng, fitBuilder, designBuilder) {
    const groupKey = r => (r.group !== undefined ? r.group : r.batch);
    const groupIds = Array.from(new Set(rows.map(groupKey)));
    rng.shuffle(groupIds);
    const assignment = new Map();
    groupIds.forEach((g, i) => assignment.set(g, i % folds));
    const foldErr = [];
    for (let f = 0; f < folds; f++) {
      const tr = rows.filter(r => assignment.get(groupKey(r)) !== f);
      const te = rows.filter(r => assignment.get(groupKey(r)) === f);
      if (!te.length || !tr.length) {
        if (te.length) foldErr.push({ fold: f, nTest: te.length, rmse: null, mae: null, rankDeficient: true });
        continue;
      }
      const built = designBuilder(tr); // 标准化参数只来自训练批次
      const Xtr = tr.map(r => built.x(r));
      const ytr = tr.map(r => r.y !== undefined ? r.y : r.loss);
      const fit = fitBuilder(Xtr, ytr);
      if (!fit.fullRank) {
        foldErr.push({ fold: f, nTest: te.length, rmse: null, mae: null, rankDeficient: true });
        continue;
      }
      const yhat = te.map(r => {
        const xr = built.x(r);
        let s = 0;
        for (let j = 0; j < xr.length; j++) s += fit.beta[j] * xr[j];
        return s;
      });
      const yte = te.map(r => (r.y !== undefined ? r.y : r.loss));
      foldErr.push({ fold: f, nTest: te.length, groups: te.map(r => groupKey(r)), rmse: rmse(yte, yhat), mae: mae(yte, yhat) });
    }
    const ok = foldErr.filter(e => e.rmse !== null);
    const pooled = ok.length ? {
      rmse: Math.sqrt(ok.reduce((s, e) => s + e.rmse * e.rmse * e.nTest, 0) / ok.reduce((s, e) => s + e.nTest, 0)),
      mae: ok.reduce((s, e) => s + e.mae * e.nTest, 0) / ok.reduce((s, e) => s + e.nTest, 0)
    } : { rmse: null, mae: null };
    return { foldErr, pooled, folds, assignment };
  }

  return {
    HUBER_K, RANK_TOL,
    zeros, matT, matVec, vecSub, vecAdd, mean, variance, mad, median,
    qrPivot, solveQR, ols, huber, diagnostics, dfbetaSingle,
    rmse, mae, groupedKFold
  };
});
