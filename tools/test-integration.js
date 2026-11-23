/* 流水线与导入的集成测试（Node 环境，无 DOM）。 */
'use strict';
const S = require('../js/stats.js');
const P = require('../js/pipeline.js');
const I = require('../js/importer.js');
const { Sample } = require('../js/sample-data.js');
const fs = require('fs');
const path = require('path');

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };
const approx = (a, b, eps) => Math.abs(a - b) <= eps;

// ---- 1. 全量拟合与物理系数 ----
const ols = P.fitModel(Sample.rows, 'ols');
const hub = P.fitModel(Sample.rows, 'huber');
ok(ols.fit.fullRank && hub.fit.fullRank, '全量 OLS/Huber 均满秩');
const phys = P.physicalCoefficients(ols);
ok(approx(phys[1], 0.1759, 0.01), `物理温度系数 ≈0.176 %/°C（实际 ${phys[1].toFixed(4)}，真实关系 0.12，被 B-HL 拉偏）`);
const physSE = P.physicalSE(ols);
ok(physSE[1] > 0 && physSE[1] < 0.05, `物理温度系数标准误为正且量级合理 (${physSE[1].toFixed(4)})`);

// ---- 2. LBO 真实重拟合：B-HL ----
const lboHL = P.leaveBatchOut(ols, 'B-HL', 'ols');
ok(lboHL.model.fit.fullRank, '排除 B-HL 后仍满秩（有覆盖）');
ok(Math.abs(lboHL.model.fit.beta[1] - ols.fit.beta[1]) > 0.5,
  `排除 B-HL 温度系数真实重拟合变化 ${(lboHL.model.fit.beta[1] - ols.fit.beta[1]).toFixed(4)}`);
// 标准化参数确实重新估计
ok(lboHL.model.design.scaling.tMean !== ols.design.scaling.tMean, 'LBO 重新估计标准化均值');
// 留出误差存在且为正
ok(lboHL.heldOut && lboHL.heldOut.rmse > 0, '被排除批次留出 RMSE 已计算');

// 与单点 DFBETA 近似并列：证明二者不同
const dfbeta = S.dfbetaSingle(ols.fit, ols.X, ols.y);
const hlRows = Sample.rows.map((r, i) => r.batch === 'B-HL' ? i : -1).filter(i => i >= 0);
const singleSum = hlRows.reduce((acc, i) => acc + dfbeta[i][1], 0);
const realDelta = lboHL.model.fit.beta[1] - ols.fit.beta[1];
ok(Math.abs(singleSum - realDelta) > 0.05,
  `单点 DFBETA 之和 (${singleSum.toFixed(4)}) ≠ 整批删除真实变化 (${realDelta.toFixed(4)})，二者不可互相替代`);

// ---- 3. 降秩：B-RANK ----
const lboRank = P.leaveBatchOut(ols, 'B-RANK', 'ols');
ok(!lboRank.model.fit.fullRank && lboRank.model.fit.rank === 4, '排除 B-RANK 后秩 4/5');
ok(lboRank.coverIssues.some(c => c.includes('C3')), '报告 C3 工况无覆盖');
ok(lboRank.heldOut === null, '降秩情景不产生留出误差数字');
const predRank = P.predict(lboRank.model, { temperature: 150, speed: 40, condition: 'C1' });
ok(predRank.value === null, '降秩模型不输出预测值');

// ---- 4. 预测与外推 ----
const inP = P.predict(ols, { temperature: 150, speed: 40, condition: 'C1' });
ok(inP.inDomain === true && inP.value !== null, '覆盖内预测正常');
const outP = P.predict(ols, { temperature: 210, speed: 40, condition: 'C1' });
ok(outP.inDomain === false && outP.reasons.some(r => r.includes('温度')), '温度超范围明确标注外推原因');
const outC3 = P.predict(lboRank.model, { temperature: 142, speed: 40, condition: 'C3' });
ok(outC3.value === null, '降秩后 C3 预测拒绝输出');
// 排除 B-HL 后在 178°C 预测变为外推
const lboPred = P.predict(lboHL.model, { temperature: 178, speed: 40, condition: 'C1' });
ok(lboPred.inDomain === false, '排除 B-HL 后 178°C 失去覆盖，标外推');

// ---- 5. 批次诊断标记 ----
const diag = S.diagnostics(ols.fit, ols.y, Sample.rows.map(r => r.batch));
const bd = P.batchDiagnostics({ ...ols, huber: hub.fit }, diag);
const flagOf = b => (bd.find(x => x.batch === b) || { flags: [] }).flags;
ok(flagOf('B-OUT').includes('singleOutlier'), 'B-OUT 标记单条异常');
ok(!flagOf('B-OUT').includes('batchShift'), 'B-OUT 不是整批偏移');
ok(flagOf('B-SHIFT').includes('batchShift'), 'B-SHIFT 标记整批偏移');
ok(!flagOf('B-SHIFT').includes('singleOutlier'), 'B-SHIFT 不标记单条异常');
ok(flagOf('B-HL').includes('highLeverage'), 'B-HL 标记高杠杆');

// ---- 6. 导入去重：真实 CSV 往返 ----
const store = I.createStore(null);
const csvText = fs.readFileSync(path.join(__dirname, '..', 'sample-data', 'measurements_B-04.csv'), 'utf8');
const ev1 = store.importCsvText(csvText, 'measurements_B-04.csv', Sample.meta);
ok(ev1.rowsAdded === 8 && ev1.status === 'accepted', '首次导入 B-04：8 条全部计入');
const ev2 = store.importCsvText(csvText, 'measurements_B-04.csv', Sample.meta);
ok(ev2.rowsAdded === 0 && ev2.rowsSkippedDuplicate === 8 && ev2.status === 'duplicate',
  '重复导入同一测量文件：0 新增、8 条重复跳过');
ok(store.rows.length === 8, '存储中仍只有 8 条（不重复计权）');
// 损坏文件
const bad = store.importCsvText('a,b\n1,2', 'bad.csv', Sample.meta);
ok(bad.status === 'rejected', '缺列文件被拒绝并记录事件');
const partial = I.parseCsv('measurement_id,source,batch,condition,temperature_c,speed_m_min,loss_pct\nX1,S1,BX,C1,not-a,40,8\nX2,S1,BX,C1,150,40,8.2');
ok(partial.rows.length === 1 && partial.errors.length === 1, '坏行跳过、好行保留');

// ---- 7. 内置示例存储的台账与数据一致 ----
const store2 = I.createStore(Sample);
ok(store2.rows.length === Sample.rows.length, '内置数据装载行数一致');
ok(store2.importLog.some(e => e.status === 'duplicate'), '内置台账含一次重复导入事件');
const dupSkipped = store2.importLog.reduce((s, e) => s + e.rowsSkippedDuplicate, 0);
ok(dupSkipped === 8, `台账记录 8 条重复跳过（实际 ${dupSkipped}）`);

// ---- 8. LBO 扫描：全部批次真实重拟合，降秩项不为 null 崩溃 ----
const scan = P.lboScan(ols, 'ols');
ok(scan.length === 14, '扫描覆盖 14 个批次');
ok(scan.every(s => s.rankDeficient || Array.isArray(s.deltas)), '满秩项有 deltas、降秩项安全降级');
const rankItem = scan.find(s => s.batch === 'B-RANK');
ok(rankItem.rankDeficient && rankItem.deltas === null, 'B-RANK 扫描项标记降秩且无虚高系数');

console.log(fails ? `\n${fails} 项失败` : '\n全部集成测试通过');
process.exit(fails ? 1 : 0);
