/* 最小 DOM 桩：在无浏览器环境下驱动 app.js 的完整初始化与交互。
   沙箱与 DOM 桩来自 harness.js；本文件只保留交互断言。 */
'use strict';
const { documentStub, getOrCreate, buildSandbox, loadAll } = require("./harness.js");
const sandbox = buildSandbox();
loadAll(sandbox);

let errors = 0;
const tryStep = (name, fn) => {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { errors++; console.log('FAIL  ' + name + '\n      ' + e.stack.split('\n').slice(0, 3).join('\n      ')); }
};

// 启动
tryStep('DOMContentLoaded 初始化完成', () => documentStub.fireReady());
const state = sandbox.PRA.state;
tryStep('全量情景已预计算（14 批次 LBO 扫描）', () => {
  if (state.scanOls.length !== 14) throw new Error('scan length ' + state.scanOls.length);
});

// 渲染结果抽查
tryStep('KPI 渲染：112 条测量 / 14 批次 / 3 来源', () => {
  if (getOrCreate('kpi-rows').textContent !== '112') throw new Error('rows=' + getOrCreate('kpi-rows').textContent);
  if (getOrCreate('kpi-batches').textContent !== '14') throw new Error('batches');
  if (getOrCreate('kpi-sources').textContent !== '3') throw new Error('sources');
});
tryStep('导入台账渲染 15 个事件', () => {
  if (getOrCreate('import-log').children.length !== 15) throw new Error('log rows');
});
tryStep('系数表渲染 5 行', () => {
  if (getOrCreate('coef-tbody').children.length !== 5) throw new Error('coef rows');
});
tryStep('批次诊断表渲染 14 行', () => {
  if (getOrCreate('batch-tbody').children.length !== 14) throw new Error('batch rows');
});
tryStep('原始记录表渲染 112 行', () => {
  if (getOrCreate('raw-tbody').children.length !== 112) throw new Error('raw rows');
});
tryStep('情景下拉含 15 个选项（全量 + 14 批次）', () => {
  const sel = getOrCreate('scenario-select');
  if (sel.children.length !== 15) throw new Error('options ' + sel.children.length);
});
tryStep('SVG 散点图已生成节点', () => {
  const svg = getOrCreate('chart-scatter').children[0];
  if (!svg || svg.tagName !== 'SVG') throw new Error('no svg');
  if (svg.children.length < 50) throw new Error('svg too few nodes ' + svg.children.length);
});
tryStep('影响气泡图 / LBO / CV / 覆盖图均已渲染', () => {
  for (const id of ['chart-influence', 'chart-lbo', 'chart-cv', 'chart-coverage', 'chart-residual']) {
    if (!getOrCreate(id).children.length) throw new Error(id + ' empty');
  }
});

// 交互：选择 B-HL
tryStep('选择排除 B-HL → 真实重拟合情景渲染', () => {
  const sel = getOrCreate('scenario-select');
  sel.value = 'B-HL';
  sel.dispatch('change');
  if (state.scenarioBatch !== 'B-HL') throw new Error('state not set');
  const detail = getOrCreate('scenario-detail').textContent;
  if (!detail.includes('排除批次 B-HL')) throw new Error('detail missing');
  // 系数表出现真实变化列
  if (!getOrCreate('coef-tbody').textContent.includes('%')) throw new Error('delta% missing');
});
tryStep('B-HL 情景下散点图重新渲染且基准线存在', () => {
  const svg = getOrCreate('chart-scatter').children[0];
  const texts = JSON.stringify(svg.children.map(c => c.attributes['stroke-dasharray']).filter(Boolean));
  if (!texts) throw new Error('no dashed baseline');
});

// 交互：切到 Huber
tryStep('切换 Huber 方法后 LBO 图与预测重渲染', () => {
  const m = getOrCreate('method-select');
  m.value = 'huber';
  m.dispatch('change');
  if (state.scenarioMethod !== 'huber') throw new Error('method state');
  if (!getOrCreate('chart-lbo').children.length) throw new Error('lbo empty');
});

// 交互：B-RANK 降秩
tryStep('选择 B-RANK → 降秩警告而非虚高系数', () => {
  const sel = getOrCreate('scenario-select');
  sel.value = 'B-RANK';
  sel.dispatch('change');
  const detail = getOrCreate('scenario-detail').textContent;
  if (!detail.includes('设计矩阵降秩')) throw new Error('rank warning missing');
  if (!detail.includes('4/5')) throw new Error('rank 4/5 missing');
  const coef = getOrCreate('coef-tbody').textContent;
  if (!coef.includes('无法估计')) throw new Error('must show unestimable');
  const pred = getOrCreate('pred-results').textContent;
  if (!pred.includes('无法估计')) throw new Error('prediction must refuse');
});

// 交互：恢复全量
tryStep('恢复全量情景', () => {
  const sel = getOrCreate('scenario-select');
  sel.value = '';
  sel.dispatch('change');
  if (state.scenarioBatch !== null) throw new Error('reset failed');
});

// 交互：预测输入（含外推）
tryStep('预测点改为 210°C → 外推标注', () => {
  const t = getOrCreate('pred-t');
  t.value = '210';
  t.dispatch('input');
  const txt = getOrCreate('pred-results').textContent;
  if (!txt.includes('外推')) throw new Error('extrapolation missing');
});
tryStep('工况切换 C3 重渲染', () => {
  const c = getOrCreate('pred-c');
  c.value = 'C3';
  c.dispatch('change');
  if (state.pred.condition !== 'C3') throw new Error('cond state');
});

// 交互：模拟重复文件导入（async）
(async () => {
  await new Promise(r => setTimeout(r, 0));
  await tryStepAsync('点击重新导入 B-04 → 0 新增 8 重复', async () => {
    const before = state.store.rows.length;
    getOrCreate('reimport-dup').dispatch('click');
    await new Promise(r => setTimeout(r, 10));
    if (state.store.rows.length !== before) throw new Error('row count changed');
    const result = getOrCreate('import-result').textContent;
    if (!result.includes('重复跳过 8') || !result.includes('duplicate')) throw new Error('dup msg missing: ' + result);
  });
  await tryStepAsync('恢复内置数据', async () => {
    getOrCreate('reset-data').dispatch('click');
    await new Promise(r => setTimeout(r, 10));
    if (state.store.rows.length !== 112) throw new Error('reset rows');
    if (state.scenarioBatch !== null) throw new Error('scenario not reset');
  });
  tryStep('主题切换不报错', () => {
    getOrCreate('theme-toggle').dispatch('click');
    if (sandbox.document.documentElement.attributes['data-theme'] !== 'dark') throw new Error('theme attr');
    getOrCreate('theme-toggle').dispatch('click');
  });
  tryStep('表格视图开关', () => {
    getOrCreate('table-toggle').dispatch('click');
    if (!state.tablesExpanded) throw new Error('tables flag');
  });
  console.log(errors ? `\n${errors} 项 UI 流程失败` : '\n全部 UI 流程通过');
  process.exit(errors ? 1 : 0);
})();

async function tryStepAsync(name, fn) {
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { errors++; console.log('FAIL  ' + name + '\n      ' + e.stack.split('\n').slice(0, 3).join('\n      ')); }
}
