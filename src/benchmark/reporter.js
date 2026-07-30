const fs = require('fs-extra');
const path = require('path');

async function generateReport(allResults, outputDir) {
  fs.ensureDirSync(outputDir);

  const jsonData = buildJsonData(allResults);
  const jsonPath = path.join(outputDir, 'benchmark-report.json');
  await fs.writeJson(jsonPath, jsonData, { spaces: 2 });

  const html = buildHtmlReport(jsonData);
  const htmlPath = path.join(outputDir, 'benchmark-report.html');
  await fs.writeFile(htmlPath, html, 'utf-8');
}

function buildJsonData(allResults) {
  const engineNames = [...new Set(allResults.flatMap((d) => d.engines.map((e) => e.name)))];

  const summary = {};
  for (const ename of engineNames) {
    const metrics = allResults.flatMap((d) => {
      const e = d.engines.find((x) => x.name === ename);
      return e && e.metrics ? [e.metrics] : [];
    });

    if (metrics.length === 0) {
      summary[ename] = null;
      continue;
    }

    summary[ename] = {
      avgCer: metrics.reduce((s, m) => s + m.cer, 0) / metrics.length,
      avgWer: metrics.reduce((s, m) => s + m.wer, 0) / metrics.length,
      avgConfidence: metrics.reduce((s, m) => s + m.avgConfidence, 0) / metrics.length,
      avgSpeed: metrics.reduce((s, m) => s + m.speed, 0) / metrics.length,
      avgLayoutQuality: metrics.reduce((s, m) => s + m.layoutQuality, 0) / metrics.length,
      avgTableQuality: metrics.reduce((s, m) => s + m.tableQuality, 0) / metrics.length,
      avgStructureQuality: metrics.reduce((s, m) => s + m.structureQuality, 0) / metrics.length,
      totalTimeMs: metrics.reduce((s, m) => s + m.durationMs, 0),
      totalPages: metrics.reduce((s, m) => s + m.numPages, 0),
      docCount: metrics.length,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    summary,
    details: allResults,
  };
}

function buildHtmlReport(jsonData) {
  const { summary, details } = jsonData;
  const engineNames = Object.keys(summary).filter((k) => summary[k] !== null);

  const engineColors = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6'];

  const summaryRows = engineNames.map((name, i) => {
    const s = summary[name];
    if (!s) return '';
    const color = engineColors[i % engineColors.length];
    return `
      <tr>
        <td style="color:${color};font-weight:bold">${name}</td>
        <td>${(s.avgCer * 100).toFixed(1)}%</td>
        <td>${(s.avgWer * 100).toFixed(1)}%</td>
        <td>${(s.avgConfidence * 100).toFixed(1)}%</td>
        <td>${s.avgSpeed.toFixed(1)}</td>
        <td>${(s.avgLayoutQuality * 100).toFixed(1)}%</td>
        <td>${(s.avgTableQuality * 100).toFixed(1)}%</td>
        <td>${(s.avgStructureQuality * 100).toFixed(1)}%</td>
        <td>${s.docCount}</td>
      </tr>`;
  }).join('');

  const bestCer = engineNames.length > 0
    ? engineNames.reduce((a, b) => (summary[a].avgCer < summary[b].avgCer ? a : b))
    : '-';

  const detailsSections = details.map((doc) => {
    const docEngines = doc.engines.map((e, i) => {
      const color = engineColors[i % engineColors.length];
      if (e.error) {
        return `<tr><td style="color:${color};font-weight:bold">${e.name}</td><td colspan="7" style="color:#e74c3c">ERROR: ${e.error}</td></tr>`;
      }
      if (!e.metrics) return '';
      const m = e.metrics;
      return `<tr>
        <td style="color:${color};font-weight:bold">${e.name}</td>
        <td>${(m.cer * 100).toFixed(1)}%</td>
        <td>${(m.wer * 100).toFixed(1)}%</td>
        <td>${(m.avgConfidence * 100).toFixed(1)}%</td>
        <td>${m.speed.toFixed(1)}</td>
        <td>${(m.layoutQuality * 100).toFixed(1)}%</td>
        <td>${(m.tableQuality * 100).toFixed(1)}%</td>
        <td>${(m.structureQuality * 100).toFixed(1)}%</td>
      </tr>`;
    }).join('');

    return `<div class="doc-section">
      <h3 onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none'" style="cursor:pointer">📄 ${doc.name}</h3>
      <div style="display:none">
        <table><tr><th>Engine</th><th>CER</th><th>WER</th><th>Confidence</th><th>Speed (pg/s)</th><th>Layout</th><th>Table</th><th>Structure</th></tr>
        ${docEngines}
        </table>
      </div>
    </div>`;
  }).join('');

  const barData = engineNames.map((name) => {
    const s = summary[name];
    return {
      label: name,
      cer: (s.avgCer * 100).toFixed(1),
      wer: (s.avgWer * 100).toFixed(1),
      layout: (s.avgLayoutQuality * 100).toFixed(1),
      table: (s.avgTableQuality * 100).toFixed(1),
      structure: (s.avgStructureQuality * 100).toFixed(1),
      speed: s.avgSpeed.toFixed(1),
      color: engineColors[engineNames.indexOf(name) % engineColors.length],
    };
  }).map((d) => {
    return `<div class="bar-group">
      <div class="bar-label">${d.label}</div>
      <div class="bars">
        <div class="bar-row"><span>CER</span><div class="bar-track"><div class="bar-fill" style="width:${d.cer}%;background:#e74c3c"></div></div><span>${d.cer}%</span></div>
        <div class="bar-row"><span>Layout</span><div class="bar-track"><div class="bar-fill" style="width:${d.layout}%;background:#2ecc71"></div></div><span>${d.layout}%</span></div>
        <div class="bar-row"><span>Table</span><div class="bar-track"><div class="bar-fill" style="width:${d.table}%;background:#3498db"></div></div><span>${d.table}%</span></div>
        <div class="bar-row"><span>Struct</span><div class="bar-track"><div class="bar-fill" style="width:${d.structure}%;background:#9b59b6"></div></div><span>${d.structure}%</span></div>
        <div class="bar-row"><span>Speed</span><div class="bar-track"><div class="bar-fill" style="width:${Math.min(100, d.speed * 10)}%;background:#f39c12"></div></div><span>${d.speed} pg/s</span></div>
      </div>
    </div>`;
  }).join('');

  const tableHtml = engineNames.map((name, i) => {
    const color = engineColors[i % engineColors.length];
    return `<span style="display:inline-block;width:12px;height:12px;background:${color};border-radius:2px;margin-right:4px"></span>${name}`;
  }).join(' &nbsp; ');

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Benchmark OCR Engine</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f6fa; color: #2c3e50; padding: 30px; }
  h1 { font-size: 24px; margin-bottom: 5px; }
  .subtitle { color: #7f8c8d; margin-bottom: 20px; font-size: 14px; }
  .card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); padding: 24px; margin-bottom: 24px; }
  h2 { font-size: 18px; margin-bottom: 16px; color: #2c3e50; }
  .best { background: #d4edda; border: 1px solid #c3e6cb; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #ecf0f1; }
  th { background: #f8f9fa; font-weight: 600; color: #7f8c8d; text-transform: uppercase; letter-spacing: 0.5px; font-size: 11px; }
  tr:hover { background: #f8f9fa; }
  .charts { display: flex; gap: 24px; flex-wrap: wrap; }
  .bar-group { margin-bottom: 16px; }
  .bar-label { font-weight: 600; font-size: 14px; margin-bottom: 6px; }
  .bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px; }
  .bar-row span:first-child { width: 60px; color: #7f8c8d; }
  .bar-row span:last-child { width: 50px; text-align: right; color: #7f8c8d; }
  .bar-track { flex: 1; height: 18px; background: #ecf0f1; border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
  .legend { margin-bottom: 16px; font-size: 13px; color: #7f8c8d; }
  .doc-section { margin-bottom: 8px; }
  .doc-section h3 { font-size: 14px; padding: 8px 0; }
  .doc-section table { font-size: 12px; }
  .doc-section td, .doc-section th { padding: 6px 8px; }
</style>
</head>
<body>
<h1>🔬 Benchmark OCR Engine</h1>
<div class="subtitle">Generated: ${new Date(jsonData.generatedAt).toLocaleString('id-ID')}</div>

<div class="card">
  <h2>Ringkasan</h2>
  ${bestCer !== '-' ? `<div class="best">🏆 Engine terbaik (CER terendah): <strong>${bestCer}</strong></div>` : ''}
  <table>
    <tr>
      <th>Engine</th><th>CER</th><th>WER</th><th>Confidence</th><th>Speed (pg/s)</th><th>Layout</th><th>Table</th><th>Structure</th><th>Docs</th>
    </tr>
    ${summaryRows}
  </table>
</div>

<div class="card">
  <h2>Perbandingan Visual</h2>
  <div class="legend">${tableHtml}</div>
  <div class="charts">
    ${barData}
  </div>
</div>

<div class="card">
  <h2>Detail per Dokumen</h2>
  ${detailsSections}
</div>

</body>
</html>`;
}

module.exports = { generateReport };
