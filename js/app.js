/* 应用主控：状态管理 + 视图编排。
   分析情景（排除批次）只影响拟合输入，原始数据永不修改。 */
(function () {
  'use strict';
  const { Stats: S, Pipeline: P, Importer: I, Charts: C, Rng, Sample } = window.PRA;

  const state = {
    store: null,
    scenarioBatch: null,      // 排除情景中的批次 id；null = 全量情景
    scenarioMethod: 'ols',
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    tablesExpanded: false,
    pred: { temperature: 155, speed: 41, condition: 'C1' },
    cvFolds: 5,
    cvSeed: 7,
    full: null,               // 全量情景的预计算包
    scanOls: null, scanHub: null
  };

  const COLOR = {
    S1: 'var(--series-1)', S2: 'var(--series-2)', S3: 'var(--series-3)'
  };
  const sourceColor = r => COLOR[r.source] || 'var(--ink-muted)';

  // ---------- 计算 ----------

  function computeFull(rows) {
    const olsModel = P.fitModel(rows, 'ols');
    const hubModel = P.fitModel(rows, 'huber');
    const pointDiag = S.diagnostics(olsModel.fit, olsModel.y, rows.map(r => r.batch));
    const dfbeta = S.dfbetaSingle(olsModel.fit, olsModel.X, olsModel.y);
    const batchDiag = P.batchDiagnostics({ ...olsModel, huber: hubModel.fit }, pointDiag);
    const rngO = Rng.makeRng(state.cvSeed);
    const rngH = Rng.makeRng(state.cvSeed); // 同折分配，保证两方法面对相同留出批次
    const cvOls = S.groupedKFold(rows, state.cvFolds, rngO, (X, y) => S.ols(X, y), P.makeDesign);
    const cvHub = S.groupedKFold(rows, state.cvFolds, rngH, (X, y) => S.huber(X, y), P.makeDesign);
    return { olsModel, hubModel, pointDiag, dfbeta, batchDiag, cvOls, cvHub };
  }

  function recompute() {
    const rows = state.store.rows;
    state.full = computeFull(rows);
    state.scanOls = P.lboScan(state.full.olsModel, 'ols');
    state.scanHub = P.lboScan(state.full.hubModel, 'huber');
  }

  // 当前情景下的模型（真实整批删除 + 完整重拟合）
  function scenarioModels() {
    if (!state.scenarioBatch) {
      return {
        ols: state.full.olsModel, huber: state.full.hubModel,
        lbo: null, removedRows: []
      };
    }
    const lboOls = P.leaveBatchOut(state.full.olsModel, state.scenarioBatch, 'ols');
    const lboHub = P.leaveBatchOut(state.full.hubModel, state.scenarioBatch, 'huber');
    return {
      ols: lboOls.model, huber: lboHub.model,
      lboOls, lboHub,
      removedRows: lboOls.removed,
      coverIssues: lboOls.coverIssues
    };
  }

  // ---------- 小工具 ----------

  function $(id) { return document.getElementById(id); }
  function ce(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function fmt(v, d = 3) { return P.fmt(v, d); }
  function pct(v, d = 1) { return v === null ? '—' : (v * 100).toFixed(d) + '%'; }

  // 图表的表格视图孪生：每个 SVG 图都有等价的可键盘访问数据表
  function fillTableView(id, table) {
    const tb = $(id);
    if (!tb || !table) return;
    tb.textContent = '';
    for (const row of table.rows) {
      const tr = ce('tr');
      for (const v of row) tr.appendChild(ce('td', null, String(v)));
      tb.appendChild(tr);
    }
  }

  function flagLabel(f) {
    return {
      singleOutlier: ['单条异常', 'status-critical'],
      batchShift: ['整批偏移', 'status-serious'],
      highLeverage: ['高杠杆', 'status-warning'],
      influential: ['强影响', 'status-violet']
    }[f] || [f, ''];
  }

  // ---------- 渲染：顶部概览与导入 ----------

  function renderOverview() {
    const rows = state.store.rows;
    const batches = new Set(rows.map(r => r.batch));
    const sources = new Set(rows.map(r => r.source));
    $('kpi-rows').textContent = rows.length;
    $('kpi-batches').textContent = batches.size;
    $('kpi-sources').textContent = sources.size;
    const dupEvents = state.store.importLog.filter(e => e.status === 'duplicate');
    const skipped = state.store.importLog.reduce((s, e) => s + (e.rowsSkippedDuplicate || 0), 0);
    $('kpi-dup').textContent = skipped;
    $('kpi-dup-sub').textContent = dupEvents.length + ' 次重复导入事件';

    const log = $('import-log');
    log.textContent = '';
    for (const e of state.store.importLog) {
      const tr = ce('tr');
      const statusCls = e.status === 'accepted' ? 'badge good' : e.status === 'duplicate' ? 'badge muted' : 'badge warn';
      const statusText = { accepted: '已计入', duplicate: '重复跳过', partial: '部分计入', rejected: '已拒绝' }[e.status];
      [e.eventId, e.fileName, e.sourceLabel || (e.sources && e.sources.join(',')) || '—',
        e.batch || (e.batches && e.batches.join(',')) || '—',
        e.rowsInFile, e.rowsAdded, e.rowsSkippedDuplicate]
        .forEach(v => { const td = ce('td'); td.textContent = v; tr.appendChild(td); });
      const td = ce('td');
      const b = ce('span', statusCls, statusText);
      td.appendChild(b);
      tr.appendChild(td);
      log.appendChild(tr);
    }
  }

  // ---------- 渲染：系数表 ----------

  function renderCoefficients() {
    const sc = scenarioModels();
    const fullOls = state.full.olsModel;
    const fullHub = state.full.hubModel;
    const tbody = $('coef-tbody');
    tbody.textContent = '';
    const names = P.COEF_LABELS;
    const physOls = P.physicalCoefficients(sc.ols);
    const physHub = P.physicalCoefficients(sc.huber);
    const seOls = P.physicalSE(sc.ols);
    for (let j = 0; j < names.length; j++) {
      const tr = ce('tr');
      tr.appendChild(ce('td', null, names[j]));
      // OLS 标准化系数
      appendCoefCell(tr, sc.ols.fit.beta[j], sc.ols.fit.se ? sc.ols.fit.se[j] : null);
      // Huber 标准化系数
      appendCoefCell(tr, sc.huber.fit.beta[j], sc.huber.fit.se ? sc.huber.fit.se[j] : null);
      // 物理单位
      const tdPhys = ce('td');
      tdPhys.appendChild(ce('div', 'num', physOls[j] === null ? '无法估计' : fmt(physOls[j], 4)));
      tdPhys.appendChild(ce('div', 'sub', sc.huber.fit.fullRank ? '稳健 ' + fmt(physHub[j], 4) : '稳健 N/A'));
      tr.appendChild(tdPhys);
      // 与全量 OLS 的变化（真实重拟合差值，非近似）
      const tdDelta = ce('td');
      if (state.scenarioBatch && sc.ols.fit.fullRank && fullOls.fit.fullRank) {
        const d = sc.ols.fit.beta[j] - fullOls.fit.beta[j];
        const dPct = fullOls.fit.beta[j] !== 0 ? d / Math.abs(fullOls.fit.beta[j]) : null;
        tdDelta.appendChild(ce('div', 'num ' + (Math.abs(d) > 0.05 ? (d > 0 ? 'delta-up' : 'delta-down') : ''),
          (d >= 0 ? '+' : '') + fmt(d, 4)));
        if (dPct !== null) tdDelta.appendChild(ce('div', 'sub', (dPct >= 0 ? '+' : '') + (dPct * 100).toFixed(1) + '%'));
      } else if (state.scenarioBatch && !sc.ols.fit.fullRank) {
        tdDelta.appendChild(ce('div', 'num warn-text', 'N/A'));
      } else {
        tdDelta.appendChild(ce('div', 'sub', '全量基准'));
      }
      tr.appendChild(tdDelta);
      tbody.appendChild(tr);
    }
    // 模型状态行
    const status = $('model-status');
    status.textContent = '';
    if (state.scenarioBatch && !sc.ols.fit.fullRank) {
      status.appendChild(renderRankWarning(sc));
    } else {
      const info = ce('div', 'note');
      info.textContent = `OLS 残差标准差 σ=${fmt(sc.ols.fit.sigma, 4)}（n=${sc.ols.fit.n}, 秩 ${sc.ols.fit.rank}/${sc.ols.fit.m}）` +
        (sc.huber.fit.fullRank ? `；Huber k=${S.HUBER_K}，稳健尺度 ${fmt(sc.huber.fit.scale, 4)}，迭代 ${sc.huber.fit.iterations} 次` : '；Huber 因降秩不可估计');
      status.appendChild(info);
    }
    renderCoefTableView(names, sc, physOls, seOls);
  }

  function appendCoefCell(tr, beta, se) {
    const td = ce('td');
    if (beta === null) {
      td.appendChild(ce('div', 'num warn-text', '无法估计'));
      td.appendChild(ce('div', 'sub', '列共线'));
    } else {
      td.appendChild(ce('div', 'num', fmt(beta, 4)));
      if (se !== null) td.appendChild(ce('div', 'sub', 'se ' + fmt(se, 4)));
    }
    tr.appendChild(td);
  }

  function renderRankWarning(sc) {
    const wrap = ce('div', 'callout critical');
    const head = ce('div', 'callout-title', '⚠ 设计矩阵降秩：结论无法继续比较');
    wrap.appendChild(head);
    const detail = ce('p');
    detail.textContent = `排除批次 ${state.scenarioBatch} 后，数值秩为 ${sc.ols.fit.rank}/${sc.ols.fit.m}（列主元 QR 检测）。` +
      '缺失工况在剩余训练批次中再无样本，任何系数都没有唯一最小二乘解。本页不报巨大系数、不做系数对比；' +
      '恢复该批次或补充同工况数据后才能继续比较。';
    wrap.appendChild(detail);
    if (sc.coverIssues && sc.coverIssues.length) {
      const ul = ce('ul');
      sc.coverIssues.forEach(c => ul.appendChild(ce('li', null, c)));
      wrap.appendChild(ul);
    }
    return wrap;
  }

  function renderCoefTableView(names, sc, physOls, seOls) {
    const tb = $('coef-table-view');
    tb.textContent = '';
    names.forEach((n, j) => {
      const tr = ce('tr');
      [n,
        sc.ols.fit.beta[j] === null ? 'N/A' : sc.ols.fit.beta[j].toFixed(5),
        sc.huber.fit.beta[j] === null ? 'N/A' : sc.huber.fit.beta[j].toFixed(5),
        physOls[j] === null ? 'N/A' : physOls[j].toFixed(5)]
        .forEach(v => tr.appendChild(ce('td', null, String(v))));
      tb.appendChild(tr);
    });
  }

  // ---------- 渲染：散点与残差 ----------

  function fitLineSeries(sc) {
    // 固定速度=训练均值、工况 C1，沿温度范围画线，展示“温度→损耗”的拟合关系
    const rows = sc.ols.rows;
    const tMin = Math.min(...rows.map(r => r.temperature));
    const tMax = Math.max(...rows.map(r => r.temperature));
    const lineFor = model => {
      if (!model.fit.fullRank) return null;
      const sMean = model.design.scaling.sMean;
      const pts = [];
      for (let i = 0; i <= 40; i++) {
        const t = tMin + (tMax - tMin) * i / 40;
        const p = { temperature: t, speed: sMean, condition: 'C1' };
        pts.push({ x: t, y: P.predict(model, p).value });
      }
      return pts;
    };
    const series = [];
    if (state.scenarioBatch) {
      // 情景下：全量基准（灰虚线）+ 排除后 OLS（蓝实线）+ 排除后 Huber（橙虚线）
      const base = lineFor(state.full.olsModel);
      if (base) series.push({ name: '全量 OLS 基准', color: 'var(--ink-muted)', dash: '10 6', points: base });
      const o = lineFor(sc.ols);
      if (o) series.push({ name: `排除 ${state.scenarioBatch} 后 OLS`, color: 'var(--series-1)', points: o });
      const h = lineFor(sc.huber);
      if (h) series.push({ name: `排除后 Huber`, color: 'var(--series-2)', dash: '7 5', points: h });
    } else {
      series.push({ name: 'OLS 拟合', color: 'var(--series-1)', points: lineFor(sc.ols) });
      const h = lineFor(sc.huber);
      if (h) series.push({ name: 'Huber 稳健', color: 'var(--series-2)', dash: '7 5', points: h });
    }
    return series.filter(s => s.points);
  }

  function renderScatter() {
    const sc = scenarioModels();
    const rows = state.store.rows;
    const series = fitLineSeries(sc);
    const scatterResult = C.scatter($('chart-scatter'), rows, {
      xField: 'temperature', yField: 'loss',
      xLabel: '温度 (°C)', yLabel: '损耗 (%)',
      colorOf: sourceColor,
      dimBatch: state.scenarioBatch,
      lineSeries: series,
      tipRows: d => [
        { text: `${d.measurementId} · ${d.batch}`, cls: 'tip-title' },
        { text: `${d.sourceLabel} · ${d.conditionLabel}` },
        { text: `温度 ${d.temperature}°C，速度 ${d.speed}，损耗 ${d.loss}%` },
        ...(d.role ? [{ text: '设计角色: ' + d.role }] : [])
      ]
    });
    fillTableView('scatter-table-view', scatterResult.table);
    // 来源图例（颜色跟随实体，不随过滤重排）
    renderSourceLegend($('scatter-legend'));
  }

  function renderSourceLegend(container) {
    container.textContent = '';
    Object.entries(Sample.meta.sources).forEach(([k, label]) => {
      const item = ce('span', 'legend-item');
      const sp = ce('span', 'dot');
      sp.style.background = COLOR[k];
      item.appendChild(sp);
      item.appendChild(document.createTextNode(label));
      container.appendChild(item);
    });
  }

  function renderResidual() {
    const sc = scenarioModels();
    const active = sc.ols; // 残差视图始终基于 OLS（Huber 权重在批次表中单独展示）
    if (!active.fit.fullRank) {
      $('chart-residual').textContent = '';
      $('chart-residual').appendChild(ce('div', 'empty-warn', '当前情景设计矩阵降秩，残差视图不可用。'));
      return;
    }
    // 情景模型要重新计算其自身数据上的诊断量，不能复用全量结果
    const diag = S.diagnostics(active.fit, active.y, active.rows.map(r => r.batch));
    C.residualChart($('chart-residual'), active.rows, active.fit, {
      stud: diag, colorOf: sourceColor, dimBatch: state.scenarioBatch
    });
  }

  function renderInfluence() {
    const f = state.full;
    const influenceResult = C.influenceChart($('chart-influence'), f.pointDiag, f.olsModel.rows, {
      colorOf: sourceColor, dimBatch: state.scenarioBatch
    });
    fillTableView('influence-table-view', influenceResult.table);
    // 教学注解：B-HL 与 B-OUT 的对比
    const box = $('influence-notes');
    box.textContent = '';
    const hl = f.batchDiag.find(b => b.batch === 'B-HL');
    const out = f.batchDiag.find(b => b.batch === 'B-OUT');
    if (hl && out) {
      const scanHL = state.scanOls.find(s => s.batch === 'B-HL');
      const scanOut = state.scanOls.find(s => s.batch === 'B-OUT');
      const p1 = ce('p', null, `B-HL：最大杠杆 ${fmt(hl.maxLeverage, 3)}（平均 ${fmt(5 / f.olsModel.n, 3)} 的 ${(hl.maxLeverage / (5 / f.olsModel.n)).toFixed(1)} 倍），` +
        `但最大 |学生化残差| 仅 ${fmt(hl.maxAbsStud, 2)}——单点残差诊断几乎不会报警，整批删除后温度系数却变化 ${fmt(scanHL.deltas[1], 3)}。`);
      const p2 = ce('p', null, `B-OUT：最大 |学生化残差| ${fmt(out.maxAbsStud, 2)} 明显越界，杠杆只有 ${fmt(out.maxLeverage, 3)}，` +
        `整批删除后温度系数变化 ${fmt(scanOut.deltas[1], 3)}——离群但影响小。`);
      box.appendChild(p1); box.appendChild(p2);
    }
  }

  // ---------- 渲染：批次诊断 ----------

  function renderBatchDiag() {
    const tbody = $('batch-tbody');
    tbody.textContent = '';
    for (const b of state.full.batchDiag) {
      const tr = ce('tr');
      if (state.scenarioBatch === b.batch) tr.classList.add('row-excluded');
      tr.appendChild(ce('td', null, b.batch));
      tr.appendChild(ce('td', null, b.source));
      tr.appendChild(ce('td', null, b.condition));
      tr.appendChild(ce('td', 'num', String(b.n)));
      tr.appendChild(ce('td', 'num', fmt(b.meanResid, 3)));
      tr.appendChild(ce('td', 'num', fmt(b.maxAbsStud, 2)));
      tr.appendChild(ce('td', 'num', fmt(b.maxLeverage, 3)));
      tr.appendChild(ce('td', 'num', fmt(b.maxCooks, 3)));
      tr.appendChild(ce('td', 'num', b.minHuberWeight === null ? '—' : fmt(b.minHuberWeight, 3)));
      const tdFlags = ce('td');
      if (!b.flags.length) tdFlags.appendChild(ce('span', 'badge good', '正常'));
      b.flags.forEach(f => {
        const [label, cls] = flagLabel(f);
        tdFlags.appendChild(ce('span', 'badge ' + cls, label));
      });
      tr.appendChild(tdFlags);
      tbody.appendChild(tr);
    }
  }

  // ---------- 渲染：LBO 扫描与情景 ----------

  function renderLboScan() {
    const scan = state.scenarioMethod === 'huber' ? state.scanHub : state.scanOls;
    const items = scan.map(s => {
      const dT = s.deltas ? s.deltas[1] : null;
      const b = state.full.batchDiag.find(x => x.batch === s.batch);
      return {
        id: s.batch, label: s.batch,
        value: s.rankDeficient ? null : dT,
        nullLabel: '降秩无法比较',
        color: s.rankDeficient ? 'var(--ink-muted)' :
          (Math.abs(dT) > 0.15 ? 'var(--status-critical)' :
            Math.abs(dT) > 0.06 ? 'var(--status-serious)' : 'var(--series-1)'),
        sub: b && b.flags.length ? '标记: ' + b.flags.map(f => flagLabel(f)[0]).join('、') : '',
        tipValue: d => s.rankDeficient ? '删除后设计矩阵降秩' : `温度系数真实变化 Δ=${d.toFixed(4)}（整批删除重拟合）`
      };
    });
    C.horizontalBars($('chart-lbo'), items, {
      diverging: true, valueLabel: 'Δ 温度系数（标准化）', idLabel: '排除批次',
      format: v => (v >= 0 ? '+' : '') + v.toFixed(3)
    });
    const tb = $('lbo-table-view');
    tb.textContent = '';
    for (const s of scan) {
      const tr = ce('tr');
      tr.appendChild(ce('td', null, s.batch));
      tr.appendChild(ce('td', null, s.rankDeficient ? '降秩无法比较' : ((s.deltas[1] >= 0 ? '+' : '') + s.deltas[1].toFixed(4))));
      tb.appendChild(tr);
    }
    const note = $('lbo-note');
    note.textContent = '每个条形都是排除该批次全部测量后、重新标准化并重新求解 QR/IRLS 的真实结果，' +
      '不是 Cook\'s D / DFFITS 那类单点一阶近似。红色 = 温度系数变化超过 0.15（标准化单位）。';
  }

  function renderScenario() {
    const sel = $('scenario-select');
    sel.innerHTML = '';
    sel.appendChild(new Option('全量情景（不排除任何批次）', ''));
    for (const b of state.full.batchDiag) {
      const tags = b.flags.length ? ' [' + b.flags.map(f => flagLabel(f)[0]).join('/') + ']' : '';
      sel.appendChild(new Option(`${b.batch}（${b.source} · ${b.n} 条）${tags}`, b.batch));
    }
    sel.value = state.scenarioBatch || '';

    const panel = $('scenario-detail');
    panel.textContent = '';
    if (!state.scenarioBatch) {
      panel.appendChild(ce('div', 'note', '当前为全量基准情景。选择一个来源批次后，将对排除该批次后的数据集执行完整重新拟合。'));
      return;
    }
    const sc = scenarioModels();
    const lbo = sc.lboOls;
    const head = ce('div', 'scenario-head');
    head.appendChild(ce('strong', null, `分析情景：排除批次 ${state.scenarioBatch}（${lbo.removed.length} 条测量不参与拟合）`));
    const resetBtn = ce('button', 'btn-small', '恢复该批次（仅关闭情景，原始数据始终保留）');
    resetBtn.addEventListener('click', () => { state.scenarioBatch = null; renderAll(); });
    head.appendChild(resetBtn);
    panel.appendChild(head);

    const warn = ce('div', 'note');
    warn.appendChild(ce('span', null, `数据状态：原始 ${state.store.rows.length + lbo.removed.length} 条测量全部保留，排除仅创建分析情景，不会把可疑批次标记为错误或删除。`));
    panel.appendChild(warn);

    if (lbo.rankDeficient) {
      panel.appendChild(renderRankWarning(sc));
      // 覆盖说明
      const cov = ce('div', 'callout warning');
      cov.appendChild(ce('div', 'callout-title', '覆盖与验证'));
      const p = ce('p', null, '该情景下训练数据无法识别全部设计列，交叉验证与业务预测同样不可比；下方预测面板会逐条说明原因。');
      cov.appendChild(p);
      panel.appendChild(cov);
      return;
    }

    // 留出误差：被排除批次作为完全没见过的数据
    const grid = ce('div', 'stat-grid');
    grid.appendChild(statTile('被排除批次留出 RMSE', lbo.heldOut.rmse.toFixed(3), '百分点，模型未见过该批'));
    grid.appendChild(statTile('被排除批次留出 MAE', lbo.heldOut.mae.toFixed(3), '百分点'));
    const fullInSample = S.rmse(state.full.olsModel.y, state.full.olsModel.fit.fitted);
    const lboInSample = S.rmse(sc.ols.y, sc.ols.fit.fitted);
    grid.appendChild(statTile('训练集内 RMSE（全量）', fullInSample.toFixed(3), '含该批次时'));
    grid.appendChild(statTile('训练集内 RMSE（排除后）', lboInSample.toFixed(3), '剩余批次上'));
    panel.appendChild(grid);

    // 情景下的分组 CV（批次划分沿用固定种子；排除后折数自适应）
    const nGroups = new Set(sc.ols.rows.map(r => r.batch)).size;
    const folds = Math.min(state.cvFolds, nGroups);
    const cvO = S.groupedKFold(sc.ols.rows, folds, Rng.makeRng(state.cvSeed), (X, y) => S.ols(X, y), P.makeDesign);
    const cvH = S.groupedKFold(sc.huber.rows, folds, Rng.makeRng(state.cvSeed), (X, y) => S.huber(X, y), P.makeDesign);
    const cvNote = ce('p', 'note');
    const skipped = cvO.foldErr.filter(e => e.rankDeficient).length;
    cvNote.textContent = `情景内 ${folds} 折批次分组 CV：OLS 汇总 RMSE=${cvO.pooled.rmse === null ? 'N/A' : cvO.pooled.rmse.toFixed(4)}` +
      `，Huber=${cvH.pooled.rmse === null ? 'N/A' : cvH.pooled.rmse.toFixed(4)}。` +
      (skipped ? ` 有 ${skipped} 折因设计降秩跳过（未用任何该折信息估计参数）。` : '') +
      ' 标准化参数、Huber 尺度与权重仅在各训练折批次上估计。';
    panel.appendChild(cvNote);
  }

  function statTile(label, value, sub) {
    const d = ce('div', 'stat-tile');
    d.appendChild(ce('div', 'stat-label', label));
    d.appendChild(ce('div', 'stat-value', value));
    d.appendChild(ce('div', 'stat-sub', sub));
    return d;
  }

  // ---------- 渲染：验证 ----------

  function renderValidation() {
    const f = state.full;
    const folds = f.cvOls.foldErr.map((e, i) => ({
      label: '折 ' + (i + 1),
      groups: e.groups,
      series: [
        { name: 'OLS', color: 'var(--series-1)', value: e.rmse },
        { name: 'Huber', color: 'var(--series-2)', value: f.cvHub.foldErr[i].rmse }
      ]
    }));
    const cvResult = C.groupedBars($('chart-cv'), folds, {
      seriesLegend: [{ name: 'OLS', color: 'var(--series-1)' }, { name: 'Huber', color: 'var(--series-2)' }]
    });
    fillTableView('cv-table-view', cvResult.table);
    const sum = $('cv-summary');
    sum.textContent = '';
    const p = ce('p', null,
      `批次分组 ${state.cvFolds} 折 CV（同一随机种子分配折，OLS 与 Huber 面对完全相同的留出批次）：` +
      `OLS 汇总 RMSE ${f.cvOls.pooled.rmse.toFixed(4)} / MAE ${f.cvOls.pooled.mae.toFixed(4)}；` +
      `Huber 汇总 RMSE ${f.cvHub.pooled.rmse.toFixed(4)} / MAE ${f.cvHub.pooled.mae.toFixed(4)}。` +
      '含 B-HL 的验证折误差显著高于其他折——高杠杆批次被整批留出时，训练它的模型无法外推到该工况。');
    sum.appendChild(p);
    const p2 = ce('p', 'note',
      '每折内部：标准化均值/标准差、Huber 的 MAD 尺度与 IRLS 权重只由该折训练批次计算，验证折整批不可见。' +
      '降秩折不参与汇总，也不填充占位数字。');
    sum.appendChild(p2);
  }

  // ---------- 渲染：预测 ----------

  function renderPrediction() {
    const sc = scenarioModels();
    const point = { ...state.pred };
    const container = $('pred-results');
    container.textContent = '';
    const rows = [];
    for (const [name, model] of [['全量 OLS', state.full.olsModel], ['全量 Huber', state.full.hubModel],
    ['情景 OLS', sc.ols], ['情景 Huber', sc.huber]]) {
      if (!model.fit.fullRank) {
        rows.push({ name, value: null, cover: null });
        continue;
      }
      const r = P.predict(model, point);
      rows.push({ name, ...r });
    }
    const table = ce('table', 'data-table');
    const thead = ce('thead');
    const hr = ce('tr');
    ['模型', '预测损耗 (%)', '范围判定', '原因'].forEach(h => hr.appendChild(ce('th', null, h)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = ce('tbody');
    rows.forEach(r => {
      const tr = ce('tr');
      tr.appendChild(ce('td', null, r.name));
      tr.appendChild(ce('td', 'num', r.value === null ? '无法估计' : r.value.toFixed(3)));
      if (r.value === null) {
        tr.appendChild(ce('td', null, '—'));
        tr.appendChild(ce('td', 'warn-text', '设计矩阵降秩'));
      } else {
        const td = ce('td');
        td.appendChild(ce('span', 'badge ' + (r.inDomain ? 'good' : 'warn'), r.inDomain ? '覆盖内（插值）' : '覆盖外（外推）'));
        tr.appendChild(td);
        tr.appendChild(ce('td', 'sub', r.reasons.length ? r.reasons.join('；') : '温度/速度在训练矩形内且工况有样本'));
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);

    const activeModel = state.scenarioMethod === 'huber' ? sc.huber : sc.ols;
    if (activeModel.fit.fullRank) {
      const covResult = C.coverageChart($('chart-coverage'), activeModel.rows, point, { colorOf: sourceColor });
      fillTableView('coverage-table-view', covResult.table);
    } else {
      $('chart-coverage').textContent = '';
      $('chart-coverage').appendChild(ce('div', 'empty-warn', '当前情景降秩，覆盖图不可用。'));
    }
    const dom = P.coverage(activeModel.fit.fullRank ? activeModel.rows : state.full.olsModel.rows, point);
    $('pred-domain').textContent =
      `训练覆盖矩形：温度 [${dom.domain.tMin.toFixed(1)}, ${dom.domain.tMax.toFixed(1)}]°C，` +
      `速度 [${dom.domain.sMin.toFixed(1)}, ${dom.domain.sMax.toFixed(1)}] m/min。` +
      '范围外的预测明确标注为外推，不与插值精度混报。';
  }

  // ---------- 渲染：原始数据表 ----------

  function renderRawTable() {
    const tbody = $('raw-tbody');
    tbody.textContent = '';
    for (const r of state.store.rows) {
      const tr = ce('tr');
      if (state.scenarioBatch === r.batch) tr.classList.add('row-excluded');
      [r.measurementId, r.sourceLabel || r.source, r.batch, r.conditionLabel || r.condition,
        r.temperature, r.speed, r.loss, r.sourceFile || r.file]
        .forEach((v, i) => tr.appendChild(ce('td', i >= 4 ? 'num' : null, String(v))));
      tbody.appendChild(tr);
    }
  }

  // ---------- 总渲染 ----------

  function renderAll() {
    renderOverview();
    renderScenario();
    renderCoefficients();
    renderScatter();
    renderResidual();
    renderInfluence();
    renderBatchDiag();
    renderLboScan();
    renderValidation();
    renderPrediction();
    renderRawTable();
    document.querySelectorAll('.table-view').forEach(n => { n.style.display = state.tablesExpanded ? 'block' : 'none'; });
  }

  // ---------- 事件 ----------

  function bindEvents() {
    $('theme-toggle').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = state.theme;
      renderAll();
    });
    $('scenario-select').addEventListener('change', e => {
      state.scenarioBatch = e.target.value || null;
      renderAll();
    });
    $('method-select').addEventListener('change', e => {
      state.scenarioMethod = e.target.value;
      renderAll();
    });
    $('table-toggle').addEventListener('click', () => {
      state.tablesExpanded = !state.tablesExpanded;
      $('table-toggle').textContent = state.tablesExpanded ? '隐藏全部表格视图' : '显示全部表格视图（无障碍）';
      renderAll();
    });
    ['pred-t', 'pred-s'].forEach(id => $(id).addEventListener('input', () => {
      state.pred.temperature = Number($('pred-t').value);
      state.pred.speed = Number($('pred-s').value);
      renderPrediction();
    }));
    $('pred-c').addEventListener('change', e => { state.pred.condition = e.target.value; renderPrediction(); });

    $('file-input').addEventListener('change', async e => {
      const files = Array.from(e.target.files || []);
      const results = [];
      for (const f of files) {
        const text = await f.text();
        const ev = state.store.importCsvText(text, f.name, Sample.meta);
        results.push({ f: f.name, ev });
      }
      if (results.length) {
        recompute();
        renderAll();
        showImportResult(results);
      }
      e.target.value = '';
    });

    $('reimport-dup').addEventListener('click', async () => {
      // 读取真实 CSV 文件（B-04），再次导入以演示 measurement_id 去重
      const ev = await importBundled('measurements_B-04.csv');
      recompute(); renderAll();
      showImportResult([{ f: 'measurements_B-04.csv', ev }]);
    });
    $('reset-data').addEventListener('click', () => {
      state.store.reset(Sample);
      state.scenarioBatch = null;
      recompute();
      renderAll();
    });
  }

  async function importBundled(fileName) {
    const resp = await fetch('sample-data/' + fileName);
    const text = await resp.text();
    return state.store.importCsvText(text, fileName, Sample.meta);
  }

  function showImportResult(results) {
    const box = $('import-result');
    box.textContent = '';
    for (const { f, ev } of results) {
      const div = ce('div', 'import-line ' + (ev.status === 'rejected' ? 'crit' : ev.status === 'duplicate' ? 'muted' : ''));
      div.textContent = `${f}：文件 ${ev.rowsInFile} 行，新增 ${ev.rowsAdded}，重复跳过 ${ev.rowsSkippedDuplicate}，` +
        `无效 ${ev.rowsSkippedInvalid || 0} → ${ev.status}` +
        (ev.parseErrors && ev.parseErrors.length ? '；' + ev.parseErrors.join('；') : '');
      box.appendChild(div);
    }
  }

  // ---------- 启动 ----------

  function init() {
    document.documentElement.dataset.theme = state.theme;
    state.store = I.createStore(Sample);
    recompute();
    bindEvents();
    renderAll();
    window.PRA.state = state; // 便于控制台核查
  }
  document.addEventListener('DOMContentLoaded', init);
})();
