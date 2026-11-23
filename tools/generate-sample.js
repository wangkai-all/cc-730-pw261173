/* 虚构示例数据生成器（仅构建期运行一次，产物提交到仓库）。
   产出：
     js/sample-data.js   内嵌数据（首屏零摩擦加载）
     sample-data/*.csv   同一批数据的真实 CSV，供页面“导入文件”功能读取
   设计的四个教学批次（行为由数值生成保证，诊断仍在页面上实时计算）：
     B-HL    高杠杆、小残差、大幅拉动温度斜率（隐藏的影响点批次）
     B-RANK  唯一覆盖工况 C3 的批次，删除后设计矩阵降秩
     B-OUT   单条测量异常（残差大但杠杆普通，影响小）
     B-SHIFT 整批恒定偏移（单条都不越界，只有批次级诊断能发现）        */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeRng } = require('../js/rng.js');

const SEED = 20261123;
const rng = makeRng(SEED);

const SOURCES = {
  S1: '来源 S1（甲厂）',
  S2: '来源 S2（乙厂）',
  S3: '来源 S3（丙厂）'
};
const CONDITIONS = { C1: '标准工况', C2: '高湿工况', C3: '低温工况' };

// 真实工艺关系（物理单位）：损耗% = 8.0 + 0.12·(T-150) - 0.08·(S-40) + 工况偏移
const TRUE = { base: 8.0, bT: 0.12, bS: -0.08, c2: 0.6, c3: -0.9, noise: 0.30 };

const N_PER_BATCH = 8;

// 批次清单：source / condition / 温度中心 / 速度中心 / 角色
const BATCHES = [
  { id: 'B-01', source: 'S1', cond: 'C1', t: 146, s: 42 },
  { id: 'B-02', source: 'S1', cond: 'C1', t: 152, s: 38 },
  { id: 'B-03', source: 'S1', cond: 'C1', t: 156, s: 44 },
  { id: 'B-04', source: 'S1', cond: 'C1', t: 149, s: 36 },
  { id: 'B-HL', source: 'S1', cond: 'C1', t: 178, s: 40, role: 'highLeverage' },
  { id: 'B-05', source: 'S2', cond: 'C1', t: 144, s: 45 },
  { id: 'B-06', source: 'S2', cond: 'C1', t: 154, s: 41 },
  { id: 'B-07', source: 'S2', cond: 'C2', t: 148, s: 39 },
  { id: 'B-08', source: 'S2', cond: 'C2', t: 157, s: 43 },
  { id: 'B-RANK', source: 'S2', cond: 'C3', t: 142, s: 40, role: 'soleCondition' },
  { id: 'B-09', source: 'S3', cond: 'C1', t: 151, s: 37 },
  { id: 'B-10', source: 'S3', cond: 'C2', t: 155, s: 46 },
  { id: 'B-OUT', source: 'S3', cond: 'C2', t: 150, s: 42, role: 'singleOutlier' },
  { id: 'B-SHIFT', source: 'S3', cond: 'C2', t: 151, s: 39, role: 'batchShift' }
];

function trueMean(r) {
  let y = TRUE.base + TRUE.bT * (r.temperature - 150) + TRUE.bS * (r.speed - 40);
  if (r.condition === 'C2') y += TRUE.c2;
  if (r.condition === 'C3') y += TRUE.c3;
  return y;
}

const rows = [];
const files = new Map();
let seq = 0;

for (const b of BATCHES) {
  const batchEffect = b.role ? 0 : rng.normal(0, 0.15);
  const fileName = `measurements_${b.id}.csv`;
  for (let k = 0; k < N_PER_BATCH; k++) {
    seq++;
    const mid = `M-${String(seq).padStart(4, '0')}`;
    let temperature, speed, noise, extra = 0;
    if (b.role === 'highLeverage') {
      // 远离主体温度区，内部一致性极高，并落在一条更陡的斜率上（0.20 而非 0.12）
      temperature = b.t + rng.normal(0, 0.6);
      speed = b.s + rng.normal(0, 0.4);
      const ySteep = TRUE.base + 0.2 * (temperature - 150) + TRUE.bS * (speed - 40);
      const y = ySteep + rng.normal(0, 0.05);
      rows.push(finalize(mid, b, fileName, temperature, speed, y));
      continue;
    }
    temperature = b.t + rng.normal(0, 0.9);
    speed = b.s + rng.normal(0, 0.6);
    noise = rng.normal(0, TRUE.noise) + batchEffect;
    if (b.role === 'singleOutlier' && k === 5) extra = 2.6; // 仅单条测量异常
    if (b.role === 'batchShift') extra = 1.2;               // 整批恒定偏移（单条不越界）
    const y = trueMean({ temperature, speed, condition: b.cond }) + noise + extra;
    rows.push(finalize(mid, b, fileName, temperature, speed, y));
  }
}

function finalize(mid, b, fileName, temperature, speed, y) {
  const row = {
    measurementId: mid,
    source: b.source,
    sourceLabel: SOURCES[b.source],
    batch: b.id,
    condition: b.cond,
    conditionLabel: CONDITIONS[b.cond],
    temperature: round(temperature, 3),
    speed: round(speed, 3),
    loss: round(y, 4),
    file: fileName,
    role: b.role || null
  };
  if (!files.has(fileName)) files.set(fileName, []);
  files.get(fileName).push(row);
  return row;
}

function round(v, d) {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
}

// 导入记录：每个文件一次成功导入；另构造一次重复导入事件（同一文件再次提交，零行计入）
const importLog = [];
let t0 = new Date('2026-11-18T08:30:00Z').getTime();
for (const b of BATCHES) {
  const fileName = `measurements_${b.id}.csv`;
  t0 += 37 * 60 * 1000;
  importLog.push({
    eventId: 'IMP-' + String(importLog.length + 1).padStart(3, '0'),
    fileName,
    source: b.source,
    sourceLabel: SOURCES[b.source],
    batch: b.id,
    importedAt: new Date(t0).toISOString(),
    rowsInFile: N_PER_BATCH,
    rowsAdded: N_PER_BATCH,
    rowsSkippedDuplicate: 0,
    measurementIds: files.get(fileName).map(r => r.measurementId),
    status: 'accepted'
  });
}
// 重复测量文件：B-04 的文件被再次导入，全部 measurement_id 已存在
t0 += 41 * 60 * 1000;
const dup = importLog.find(e => e.batch === 'B-04');
importLog.push({
  eventId: 'IMP-' + String(importLog.length + 1).padStart(3, '0'),
  fileName: dup.fileName,
  source: dup.source,
  sourceLabel: dup.sourceLabel,
  batch: dup.batch,
  importedAt: new Date(t0).toISOString(),
  rowsInFile: N_PER_BATCH,
  rowsAdded: 0,
  rowsSkippedDuplicate: N_PER_BATCH,
  measurementIds: [],
  status: 'duplicate'
});

// ---- 写 CSV（真实文件，页面可通过文件选择器读取） ----
const outDir = path.join(__dirname, '..', 'sample-data');
fs.mkdirSync(outDir, { recursive: true });
const csvHeader = 'measurement_id,source,batch,condition,temperature_c,speed_m_min,loss_pct,source_file';
for (const [fileName, batchRows] of files) {
  const lines = [csvHeader];
  for (const r of batchRows) {
    lines.push([r.measurementId, r.source, r.batch, r.condition, r.temperature, r.speed, r.loss, r.file].join(','));
  }
  fs.writeFileSync(path.join(outDir, fileName), lines.join('\n') + '\n');
}

// ---- 写内嵌 JS ----
const payload = {
  meta: {
    generatedAt: new Date(t0).toISOString(),
    seed: SEED,
    trueRelationship: TRUE,
    sources: SOURCES,
    conditions: CONDITIONS,
    nPerBatch: N_PER_BATCH,
    note: '全部为虚构教学数据，不代表任何真实工艺。'
  },
  rows,
  importLog
};
const js = `/* 自动生成，请勿手改；由 tools/generate-sample.js 产出。 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.PRA = root.PRA || {};
  root.PRA.Sample = mod.Sample;
})(typeof self !== 'undefined' ? self : this, function () {
  return { Sample: ${JSON.stringify(payload, null, 2)} };
});
`;
fs.writeFileSync(path.join(__dirname, '..', 'js', 'sample-data.js'), js);

console.log(`rows=${rows.length} batches=${BATCHES.length} files=${files.size} importEvents=${importLog.length}`);
