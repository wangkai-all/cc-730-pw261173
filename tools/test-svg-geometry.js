/* SVG 几何断言：在无浏览器环境下验证图表坐标确实反映数据，
   而不只是“渲染没报错”。 */
'use strict';
const { documentStub, getOrCreate, buildSandbox, loadAll } = require('./harness.js');

const sandbox = buildSandbox();
loadAll(sandbox);
documentStub.fireReady();

let fails = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

// ---- 散点图：112 个数据圆，高温度点映射到右侧 ----
const scatterSvg = getOrCreate('chart-scatter').children[0];
check(scatterSvg && scatterSvg.tagName === 'SVG', '散点图根节点为 SVG');
const dataCircles = scatterSvg.children.filter(n => n.tagName === 'CIRCLE' && n.attributes.r === '4.5');
check(dataCircles.length === 112, `散点数据圆 112 个（实际 ${dataCircles.length}）`);
const xs = dataCircles.map(c => parseFloat(c.attributes.cx));
const ys = dataCircles.map(c => parseFloat(c.attributes.cy));
check(new Set(xs).size > 50 && new Set(ys).size > 50, '点坐标随数据变化（非重叠单一坐标）');
check(Math.max(...xs) - Math.min(...xs) > 400, '温度跨度映射为足够宽的 x 像素范围');
// 拟合线存在且为多段折线
const fitLines = scatterSvg.children.filter(n => n.tagName === 'POLYLINE');
check(fitLines.length >= 2, `至少 OLS+Huber 两条拟合线（实际 ${fitLines.length}）`);
check(fitLines.every(l => (l.attributes.points.match(/,/g) || []).length >= 30), '拟合线由 >=30 个采样点构成');

// ---- 影响气泡图：Cook's D 大气泡半径更大（每点另含一个透明命中圆） ----
const inflSvg = getOrCreate('chart-influence').children[0];
const bubbles = inflSvg.children.filter(n => n.tagName === 'CIRCLE' && (n.attributes.class || '').includes('bubble'));
check(bubbles.length === 112, `影响气泡 112 个（命中区为透明无 class 圆，实际气泡 ${bubbles.length}）`);
const radii = bubbles.map(b => parseFloat(b.attributes.r));
check(Math.max(...radii) > Math.min(...radii), "气泡半径随 Cook's D 变化（不全等）");
// 杠杆阈值竖线存在
check(inflSvg.children.some(n => n.tagName === 'LINE' && n.attributes.class === 'threshold-line'), '绘制 3p/n 杠杆阈值线');

// ---- LBO 水平条形：B-HL 条形最长，B-RANK 显示“无法估计”而非数字 ----
const lboSvg = getOrCreate('chart-lbo').children[0];
const bars = lboSvg.children.filter(n => n.tagName === 'RECT' && n.attributes.class === 'bar');
check(bars.length === 13, `LBO 条形 13 个（14 批次中 B-RANK 降秩不画条，实际 ${bars.length}）`);
const barWidths = bars.map(b => parseFloat(b.attributes.width));
const widest = Math.max(...barWidths);
check(widest > 100, `最长条形宽度 ${widest.toFixed(0)}px，对应影响最大批次`);
const nullTexts = lboSvg.children.filter(n => n.tagName === 'TEXT' && n._text === '降秩无法比较');
check(nullTexts.length === 1, 'B-RANK 位置渲染“降秩无法比较”文本而非虚高系数条');

// ---- 分组 CV 图：4 个有值折 + 1 个降秩折 ----
const cvSvg = getOrCreate('chart-cv').children[0];
const cvBars = cvSvg.children.filter(n => n.tagName === 'RECT' && n.attributes.class === 'bar');
check(cvBars.length === 8, `CV 有值柱 8 根（4 折 × OLS/Huber，实际 ${cvBars.length}）`);
const rankLabels = cvSvg.children.filter(n => n.tagName === 'TEXT' && n._text === '降秩');
check(rankLabels.length === 2, '降秩折的 OLS/Huber 两柱均以“降秩”标注');

// ---- 覆盖图：预测目标点使用状态色 ----
const covSvg = getOrCreate('chart-coverage').children[0];
const target = covSvg.children.filter(n => n.tagName === 'CIRCLE' && (n.attributes.class || '').includes('target'));
check(target.length === 1, '覆盖图含 1 个预测目标点');

// ---- 表格视图孪生：每个图的表体有数据行 ----
for (const id of ['scatter-table-view', 'influence-table-view', 'lbo-table-view', 'cv-table-view', 'coverage-table-view']) {
  const tb = getOrCreate(id);
  check(tb.children.length > 0, `${id} 表格视图已填充（${tb.children.length} 行）`);
}

console.log(fails ? `\n${fails} 项几何断言失败` : '\n全部 SVG 几何断言通过');
process.exit(fails ? 1 : 0);
