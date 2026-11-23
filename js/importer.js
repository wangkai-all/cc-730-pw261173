/* 数据导入与台账：measurement_id 全局去重（重复测量文件不重复计权），
   保留来源/批次/测量编号与每次导入事件。纯逻辑、无 DOM。 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.PRA = root.PRA || {};
  root.PRA.Importer = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const REQUIRED = ['measurement_id', 'source', 'batch', 'condition', 'temperature_c', 'speed_m_min', 'loss_pct'];

  function parseCsv(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim().length);
    if (lines.length < 2) return { ok: false, errors: ['文件为空或缺少数据行'] };
    const header = splitCsvLine(lines[0]).map(h => h.trim());
    const missing = REQUIRED.filter(c => !header.includes(c));
    if (missing.length) return { ok: false, errors: ['缺少必需列: ' + missing.join(', ')] };
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    const rows = [], errors = [];
    for (let li = 1; li < lines.length; li++) {
      const cells = splitCsvLine(lines[li]);
      const get = c => (idx[c] === undefined ? '' : (cells[idx[c]] || '').trim());
      const temperature = Number(get('temperature_c'));
      const speed = Number(get('speed_m_min'));
      const loss = Number(get('loss_pct'));
      if (!get('measurement_id') || !get('source') || !get('batch') || !get('condition')) {
        errors.push(`第 ${li + 1} 行：标识列缺失，已跳过`);
        continue;
      }
      if ([temperature, speed, loss].some(v => !Number.isFinite(v))) {
        errors.push(`第 ${li + 1} 行：数值列无法解析，已跳过`);
        continue;
      }
      rows.push({
        measurementId: get('measurement_id'),
        source: get('source'),
        batch: get('batch'),
        condition: get('condition'),
        temperature, speed, loss,
        sourceFile: get('source_file') || ''
      });
    }
    return { ok: errors.length === 0, rows, errors, header };
  }

  // 支持引号包裹的最小 CSV 行切分
  function splitCsvLine(line) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /* 存储器：rows 按 measurement_id 去重；importLog 记录每次导入（含重复导入）。 */
  function createStore(initial) {
    const rows = [];
    const seenIds = new Set();
    const importLog = [];
    let eventSeq = 0;

    function importRows(parsed, fileName, meta) {
      eventSeq++;
      const event = {
        eventId: 'IMP-' + String(eventSeq).padStart(3, '0'),
        fileName,
        importedAt: new Date().toISOString(),
        rowsInFile: parsed.rows.length,
        rowsAdded: 0,
        rowsSkippedDuplicate: 0,
        rowsSkippedInvalid: 0,
        parseErrors: parsed.errors,
        status: 'accepted',
        sources: new Set(),
        batches: new Set()
      };
      for (const r of parsed.rows) {
        if (seenIds.has(r.measurementId)) {
          event.rowsSkippedDuplicate++;
          continue;
        }
        seenIds.add(r.measurementId);
        const row = {
          ...r,
          sourceFile: r.sourceFile || fileName,
          sourceLabel: (meta && meta.sources && meta.sources[r.source]) || r.source,
          conditionLabel: (meta && meta.conditions && meta.conditions[r.condition]) || r.condition
        };
        rows.push(row);
        event.sources.add(r.source);
        event.batches.add(r.batch);
        event.rowsAdded++;
      }
      if (event.rowsAdded === 0) event.status = 'duplicate';
      else if (event.rowsSkippedDuplicate > 0 || parsed.errors.length) event.status = 'partial';
      event.sources = Array.from(event.sources);
      event.batches = Array.from(event.batches);
      importLog.push(event);
      return event;
    }

    if (initial && initial.rows) {
      for (const r of initial.rows) {
        if (seenIds.has(r.measurementId)) continue;
        seenIds.add(r.measurementId);
        rows.push({ ...r });
      }
    }
    if (initial && initial.importLog) {
      for (const e of initial.importLog) importLog.push({ ...e });
      eventSeq = importLog.length;
    }

    return {
      rows,
      importLog,
      get seenIds() { return seenIds; },
      importParsed(parsed, fileName, meta) {
        return importRows(parsed, fileName, meta);
      },
      importCsvText(text, fileName, meta) {
        const parsed = parseCsv(text);
        if (!parsed.ok) {
          eventSeq++;
          importLog.push({
            eventId: 'IMP-' + String(eventSeq).padStart(3, '0'),
            fileName, importedAt: new Date().toISOString(),
            rowsInFile: 0, rowsAdded: 0, rowsSkippedDuplicate: 0, rowsSkippedInvalid: 0,
            parseErrors: parsed.errors, status: 'rejected', sources: [], batches: []
          });
          return importLog[importLog.length - 1];
        }
        return importRows(parsed, fileName, meta);
      },
      reset(initial) {
        rows.length = 0;
        seenIds.clear();
        importLog.length = 0;
        eventSeq = 0;
        if (initial && initial.rows) {
          for (const r of initial.rows) {
            if (seenIds.has(r.measurementId)) continue;
            seenIds.add(r.measurementId);
            rows.push({ ...r });
          }
        }
        if (initial && initial.importLog) {
          for (const e of initial.importLog) importLog.push({ ...e });
          eventSeq = importLog.length;
        }
      }
    };
  }

  return { parseCsv, createStore, REQUIRED };
});
