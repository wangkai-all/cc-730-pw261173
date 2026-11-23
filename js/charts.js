/* 轻量 SVG 图表库（零依赖）。统一约定：
   - 颜色全部走 CSS 变量角色，深/浅色由 :root[data-theme] 切换
   - 标记带 2px 表面色环；散点透明命中区 >=24px，支持键盘 focus
   - 所有数据文本经 textContent 注入；每个图返回 tableData 供表格视图 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.PRA = root.PRA || {};
  root.PRA.Charts = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const M = { top: 28, right: 24, bottom: 46, left: 56 };

  function el(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function scales(domains, width, height) {
    const { x, y } = domains;
    return {
      x: v => M.left + ((v - x[0]) / (x[1] - x[0] || 1)) * (width - M.left - M.right),
      y: v => height - M.bottom - ((v - y[0]) / (y[1] - y[0] || 1)) * (height - M.top - M.bottom),
      plotW: width - M.left - M.right,
      plotH: height - M.top - M.bottom
    };
  }

  function niceDomain(lo, hi, pad) {
    const span = hi - lo || 1;
    return [lo - span * pad, hi + span * pad];
  }

  function ticks(lo, hi, count) {
    const span = hi - lo;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 0.001; v += step) out.push(+v.toFixed(8));
    return out;
  }

  function frame(svg, w, h, domains, xLabel, yLabel, sc) {
    const xs = ticks(domains.x[0], domains.x[1], 6);
    const ys = ticks(domains.y[0], domains.y[1], 5);
    xs.forEach(v => {
      const px = sc.x(v);
      el('line', { x1: px, x2: px, y1: M.top, y2: h - M.bottom, class: 'grid' }, svg);
      const t = el('text', { x: px, y: h - M.bottom + 18, class: 'tick', 'text-anchor': 'middle' }, svg);
      t.textContent = formatTick(v);
    });
    ys.forEach(v => {
      const py = sc.y(v);
      el('line', { x1: M.left, x2: w - M.right, y1: py, y2: py, class: 'grid' }, svg);
      const t = el('text', { x: M.left - 8, y: py + 4, class: 'tick', 'text-anchor': 'end' }, svg);
      t.textContent = formatTick(v);
    });
    el('line', { x1: M.left, x2: w - M.right, y1: h - M.bottom, y2: h - M.bottom, class: 'axis' }, svg);
    el('line', { x1: M.left, x2: M.left, y1: M.top, y2: h - M.bottom, class: 'axis' }, svg);
    const xl = el('text', { x: (M.left + w - M.right) / 2, y: h - 8, class: 'axis-label', 'text-anchor': 'middle' }, svg);
    xl.textContent = xLabel;
    const yl = el('text', { x: 14, y: (M.top + h - M.bottom) / 2, class: 'axis-label', 'text-anchor': 'middle', transform: `rotate(-90 14 ${(M.top + h - M.bottom) / 2})` }, svg);
    yl.textContent = yLabel;
    return { xs, ys };
  }

  function formatTick(v) {
    if (Math.abs(v) >= 100) return v.toFixed(0);
    if (Math.abs(v) >= 10) return v.toFixed(1).replace(/\.0$/, '');
    return (+v.toFixed(2)).toString();
  }

  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'pra-tooltip';
      tipEl.setAttribute('role', 'status');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(htmlRows, x, y) {
    const t = tip();
    t.textContent = '';
    for (const row of htmlRows) {
      const div = document.createElement('div');
      div.className = row.cls || 'tip-row';
      if (row.swatch) {
        const sp = document.createElement('span');
        sp.className = 'tip-swatch';
        sp.style.background = row.swatch;
        div.appendChild(sp);
      }
      const span = document.createElement('span');
      span.textContent = row.text;
      div.appendChild(span);
      t.appendChild(div);
    }
    t.style.display = 'block';
    const rect = t.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - 14;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - 14;
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

  function attachTip(node, rowsFn) {
    node.setAttribute('tabindex', '0');
    node.style.outline = 'none';
    node.addEventListener('pointerenter', e => showTip(rowsFn(), e.clientX, e.clientY));
    node.addEventListener('pointermove', e => showTip(rowsFn(), e.clientX, e.clientY));
    node.addEventListener('pointerleave', hideTip);
    node.addEventListener('focus', () => {
      const r = node.getBoundingClientRect();
      showTip(rowsFn(), r.left + r.width / 2, r.top);
    });
    node.addEventListener('blur', hideTip);
  }

  function baseSvg(container, w, h) {
    container.textContent = '';
    const svg = el('svg', { viewBox: `0 0 ${w} ${h}`, width: '100%', class: 'pra-svg', role: 'img' }, container);
    return svg;
  }

  // ---------- 散点 + 拟合线 ----------
  // opts: {xField,yField,xLabel,yLabel,colorOf(row),lineSeries:[{name,color,dash,points:[{x,y}]}],tipRows(row),dimBatch}
  function scatter(container, data, opts) {
    const W = 720, H = 420;
    const svg = baseSvg(container, W, H);
    const xVals = data.map(d => d[opts.xField]).concat((opts.lineSeries || []).flatMap(s => s.points.map(p => p.x)));
    const yVals = data.map(d => d[opts.yField]).concat((opts.lineSeries || []).flatMap(s => s.points.map(p => p.y)));
    const domains = { x: niceDomain(Math.min(...xVals), Math.max(...xVals), 0.06), y: niceDomain(Math.min(...yVals), Math.max(...yVals), 0.08) };
    const sc = scales(domains, W, H);
    frame(svg, W, H, domains, opts.xLabel, opts.yLabel, sc);

    for (const s of opts.lineSeries || []) {
      const pts = s.points.map(p => `${sc.x(p.x)},${sc.y(p.y)}`).join(' ');
      el('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': s.dash || '', class: 'fit-line' }, svg);
    }
    for (const d of data) {
      const cx = sc.x(d[opts.xField]), cy = sc.y(d[opts.yField]);
      const dim = opts.dimBatch && d.batch === opts.dimBatch;
      const c = el('circle', {
        cx, cy, r: 4.5,
        fill: opts.colorOf(d),
        class: 'pt' + (dim ? ' dimmed' : ''),
        'stroke-width': 0
      }, svg);
      const hit = el('circle', { cx, cy, r: 12, fill: 'transparent', class: 'hit' }, svg);
      attachTip(hit, () => opts.tipRows(d));
    }
    if (opts.lineSeries && opts.lineSeries.length) legend(svg, opts.lineSeries.map(s => ({ label: s.name, color: s.color, dash: s.dash })), W);
    return {
      table: {
        columns: [opts.xLabel, opts.yLabel, '来源', '批次', '工况'],
        rows: data.map(d => [d[opts.xField], d[opts.yField], d.sourceLabel || d.source, d.batch, d.conditionLabel || d.condition])
      }
    };
  }

  function legend(svg, items, W) {
    let x = M.left;
    const y = 16;
    for (const it of items) {
      el('line', { x1: x, x2: x + 22, y1: y, y2: y, stroke: it.color, 'stroke-width': 2, 'stroke-dasharray': it.dash || '' }, svg);
      const t = el('text', { x: x + 27, y: y + 4, class: 'legend-text' }, svg);
      t.textContent = it.label;
      x += 34 + it.label.length * 13;
    }
  }

  // ---------- 残差图（按拟合值） ----------
  function residualChart(container, rows, fit, opts = {}) {
    const data = rows.map((r, i) => ({
      row: r, fitted: fit.fitted[i], resid: fit.resid[i],
      stud: opts.stud ? opts.stud[i].studResid : null,
      leverage: opts.stud ? opts.stud[i].leverage : null
    }));
    return scatter(container, data, {
      xField: 'fitted', yField: 'resid',
      xLabel: '拟合损耗 (%)', yLabel: '残差 (百分点)',
      colorOf: d => opts.colorOf ? opts.colorOf(d.row) : 'var(--series-1)',
      dimBatch: opts.dimBatch,
      tipRows: d => [
        { text: `${d.row.measurementId} · ${d.row.batch}`, cls: 'tip-title' },
        { text: `拟合值 ${d.fitted.toFixed(3)}%，残差 ${d.resid.toFixed(3)}` },
        ...(d.stud !== null ? [{ text: `学生化残差 ${d.stud.toFixed(2)}，杠杆 ${d.leverage.toFixed(3)}` }] : [])
      ]
    });
  }

  // ---------- 杠杆-残差影响气泡图 ----------
  function influenceChart(container, pointDiag, rows, opts = {}) {
    const W = 720, H = 420;
    const svg = baseSvg(container, W, H);
    const data = pointDiag.map((d, i) => ({ ...d, row: rows[i] }));
    const xDom = niceDomain(0, Math.max(...data.map(d => d.leverage)) * 1.1, 0);
    const yMax = Math.max(3.2, Math.max(...data.map(d => Math.abs(d.studResid))) * 1.1);
    const domains = { x: xDom, y: [-yMax, yMax] };
    const sc = scales(domains, W, H);
    frame(svg, W, H, domains, '杠杆值 hᵢ', '学生化残差', sc);
    el('line', { x1: M.left, x2: W - M.right, y1: sc.y(0), y2: sc.y(0), class: 'zero-line' }, svg);
    el('line', { x1: sc.x(3 * (5 / rows.length)), x2: sc.x(3 * (5 / rows.length)), y1: M.top, y2: H - M.bottom, class: 'threshold-line' }, svg);
    const tx = el('text', { x: sc.x(3 * (5 / rows.length)) + 4, y: M.top + 12, class: 'annot' }, svg);
    tx.textContent = '杠杆阈值 3p/n';

    for (const d of data) {
      const r = 4 + Math.min(10, Math.sqrt(d.cooksD) * 22);
      const cx = sc.x(d.leverage), cy = sc.y(d.studResid);
      const c = el('circle', {
        cx, cy, r,
        fill: opts.colorOf ? opts.colorOf(d.row) : 'var(--series-1)',
        class: 'pt bubble' + (opts.dimBatch && d.row.batch === opts.dimBatch ? ' dimmed' : ''),
        'fill-opacity': 0.75
      }, svg);
      const hit = el('circle', { cx, cy, r: Math.max(12, r + 4), fill: 'transparent', class: 'hit' }, svg);
      attachTip(hit, () => [
        { text: `${d.row.measurementId} · ${d.row.batch}`, cls: 'tip-title' },
        { text: `学生化残差 ${d.studResid.toFixed(2)}` },
        { text: `杠杆 ${d.leverage.toFixed(3)}，Cook's D ${d.cooksD.toFixed(3)}` },
        { text: `DFFITS ${d.dffits.toFixed(3)}（单点近似）` }
      ]);
    }
    return {
      table: {
        columns: ['测量编号', '批次', '学生化残差', '杠杆', "Cook's D", 'DFFITS'],
        rows: data.map(d => [d.row.measurementId, d.row.batch, d.studResid.toFixed(3), d.leverage.toFixed(3), d.cooksD.toFixed(3), d.dffits.toFixed(3)])
      }
    };
  }

  // ---------- 水平条形（通用：批次影响 / 权重 / 验证误差） ----------
  // items: [{id,label,value,color,sub,status}]
  function horizontalBars(container, items, opts = {}) {
    const rowH = 30, W = 720;
    const H = Math.max(220, items.length * rowH + M.top + M.bottom);
    const svg = baseSvg(container, W, H);
    const vals = items.map(d => d.value).filter(v => v !== null && Number.isFinite(v));
    const diverging = opts.diverging;
    let xDom;
    if (diverging) {
      const m = Math.max(Math.abs(Math.min(...vals)), Math.abs(Math.max(...vals))) * 1.15;
      xDom = [-m, m];
    } else {
      xDom = [0, Math.max(...vals) * 1.15 || 1];
    }
    const sc = scales({ x: xDom, y: [0, 1] }, W, H);
    const xTicks = ticks(xDom[0], xDom[1], 6);
    xTicks.forEach(v => {
      el('line', { x1: sc.x(v), x2: sc.x(v), y1: M.top, y2: H - M.bottom, class: 'grid' }, svg);
      const t = el('text', { x: sc.x(v), y: H - M.bottom + 18, class: 'tick', 'text-anchor': 'middle' }, svg);
      t.textContent = formatTick(v);
    });
    if (diverging) el('line', { x1: sc.x(0), x2: sc.x(0), y1: M.top, y2: H - M.bottom, class: 'zero-line' }, svg);

    items.forEach((d, i) => {
      const y = M.top + i * rowH + 5;
      const label = el('text', { x: M.left - 8, y: y + 15, class: 'tick bar-label', 'text-anchor': 'end' }, svg);
      label.textContent = d.label;
      if (d.value === null || !Number.isFinite(d.value)) {
        const t = el('text', { x: sc.x(0) + 8, y: y + 15, class: 'annot warn-text' }, svg);
        t.textContent = d.nullLabel || '无法估计';
        return;
      }
      const x0 = diverging ? sc.x(0) : sc.x(xDom[0]);
      const x1 = sc.x(diverging ? d.value : d.value);
      const bar = el('rect', {
        x: Math.min(x0, x1), y, width: Math.max(2, Math.abs(x1 - x0)), height: 20, rx: 4,
        fill: d.color || 'var(--series-1)', class: 'bar'
      }, svg);
      const val = el('text', { x: x1 + (diverging ? (d.value >= 0 ? 6 : -6) : 6), y: y + 15, class: 'tick bar-value', 'text-anchor': diverging ? (d.value >= 0 ? 'start' : 'end') : 'start' }, svg);
      val.textContent = opts.format ? opts.format(d.value) : d.value.toFixed(3);
      const hit = el('rect', { x: M.left, y: y - 3, width: W - M.left - M.right, height: 26, fill: 'transparent', class: 'hit' }, svg);
      attachTip(hit, () => [
        { text: d.label, cls: 'tip-title' },
        { text: opts.tipValue ? opts.tipValue(d) : `数值 ${d.value.toFixed(4)}` },
        ...(d.sub ? [{ text: d.sub }] : [])
      ]);
    });
    return {
      table: {
        columns: [opts.idLabel || '项目', opts.valueLabel || '数值'],
        rows: items.map(d => [d.label, d.value === null ? (d.nullLabel || 'N/A') : (opts.format ? opts.format(d.value) : d.value.toFixed(4))])
      }
    };
  }

  // ---------- 分组验证误差柱状图 ----------
  function groupedBars(container, folds, opts = {}) {
    // folds: [{fold,label,series:[{name,color,value}]}]
    const W = 720, H = 360;
    const svg = baseSvg(container, W, H);
    const allVals = folds.flatMap(f => f.series.map(s => s.value).filter(v => v !== null));
    const domains = { x: [0, folds.length], y: [0, Math.max(...allVals) * 1.2] };
    const sc = scales(domains, W, H);
    ticks(0, domains.y[1], 5).forEach(v => {
      el('line', { x1: M.left, x2: W - M.right, y1: sc.y(v), y2: sc.y(v), class: 'grid' }, svg);
      const t = el('text', { x: M.left - 8, y: sc.y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
      t.textContent = formatTick(v);
    });
    el('line', { x1: M.left, x2: W - M.right, y1: sc.y(0), y2: sc.y(0), class: 'axis' }, svg);
    const bandW = sc.plotW / folds.length;
    const barW = Math.min(24, (bandW - 24) / Math.max(1, folds[0].series.length));
    folds.forEach((f, i) => {
      const cx = M.left + bandW * (i + 0.5);
      f.series.forEach((s, k) => {
        const x = cx - (f.series.length * barW) / 2 + k * barW + 1;
        if (s.value === null) {
          const t = el('text', { x: x + barW / 2, y: sc.y(0) - 6, class: 'annot warn-text', 'text-anchor': 'middle' }, svg);
          t.textContent = '降秩';
          const hit = el('rect', { x, y: M.top, width: barW, height: sc.plotH, fill: 'transparent' }, svg);
          attachTip(hit, () => [{ text: f.label + ' · ' + s.name, cls: 'tip-title' }, { text: '该折设计矩阵降秩，未计算误差' }]);
          return;
        }
        const y = sc.y(s.value);
        const rect = el('rect', { x, y, width: barW - 2, height: sc.y(0) - y, rx: 4, fill: s.color, class: 'bar' }, svg);
        const hit = el('rect', { x: x - 3, y, width: barW + 4, height: sc.y(0) - y + 6, fill: 'transparent' }, svg);
        attachTip(hit, () => [{ text: f.label + ' · ' + s.name, cls: 'tip-title' }, { text: `RMSE ${s.value.toFixed(4)}` }, ...(f.groups ? [{ text: '批次 ' + f.groups.join(', ') }] : [])]);
      });
      const t = el('text', { x: cx, y: H - M.bottom + 18, class: 'tick', 'text-anchor': 'middle' }, svg);
      t.textContent = f.label;
    });
    legend(svg, opts.seriesLegend.map(s => ({ label: s.name, color: s.color })), W);
    return {
      table: {
        columns: ['验证折', ...opts.seriesLegend.map(s => s.name + ' RMSE')],
        rows: folds.map(f => [f.label, ...f.series.map(s => s.value === null ? '降秩跳过' : s.value.toFixed(4))])
      }
    };
  }

  // ---------- 覆盖示意：训练批次在温度×速度平面的覆盖矩形 ----------
  function coverageChart(container, trainRows, point, opts = {}) {
    const W = 720, H = 420;
    const svg = baseSvg(container, W, H);
    const xVals = trainRows.map(r => r.temperature).concat(point ? [point.temperature] : []);
    const yVals = trainRows.map(r => r.speed).concat(point ? [point.speed] : []);
    const domains = {
      x: niceDomain(Math.min(...xVals), Math.max(...xVals), 0.08),
      y: niceDomain(Math.min(...yVals), Math.max(...yVals), 0.08)
    };
    const sc = scales(domains, W, H);
    frame(svg, W, H, domains, '温度 (°C)', '速度 (m/min)', sc);
    for (const r of trainRows) {
      const c = el('circle', { cx: sc.x(r.temperature), cy: sc.y(r.speed), r: 4, fill: opts.colorOf ? opts.colorOf(r) : 'var(--series-1)', class: 'pt' }, svg);
      const hit = el('circle', { cx: sc.x(r.temperature), cy: sc.y(r.speed), r: 12, fill: 'transparent' }, svg);
      attachTip(hit, () => [{ text: `${r.measurementId} · ${r.batch}`, cls: 'tip-title' }, { text: `温度 ${r.temperature}°C，速度 ${r.speed}` }]);
    }
    if (point) {
      const inside = point.temperature >= domains.x[0] && point.temperature <= domains.x[1] && point.speed >= domains.y[0] && point.speed <= domains.y[1];
      el('circle', { cx: sc.x(point.temperature), cy: sc.y(point.speed), r: 7, fill: inside ? 'var(--status-good)' : 'var(--status-critical)', class: 'pt target' }, svg);
      const t = el('text', { x: sc.x(point.temperature) + 10, y: sc.y(point.speed) - 8, class: 'annot' }, svg);
      t.textContent = inside ? '预测点：训练覆盖内' : '预测点：覆盖外（外推）';
    }
    return { table: { columns: ['测量编号', '批次', '温度', '速度'], rows: trainRows.map(r => [r.measurementId, r.batch, r.temperature, r.speed]) } };
  }

  return { scatter, residualChart, influenceChart, horizontalBars, groupedBars, coverageChart, hideTip, el };
});
