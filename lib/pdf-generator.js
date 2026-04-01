// Server-side PDF generation using Puppeteer
// Renders the exact same report HTML as the frontend, then converts to PDF
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const LOGO = 'data:image/png;base64,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';

// Brand color palette (same as frontend)
const PALETTE = ['#7D963D','#00b894','#e17055','#0984e3','#fdcb6e','#e84393','#00cec9','#d63031','#a29bfe','#55efc4','#fab1a0','#74b9ff','#ffeaa7','#fd79a8','#81ecec','#ff7675','#636e72','#b2bec3','#2d3436','#dfe6e9'];

function getBrandColor(name, colorMap) {
  if (colorMap[name]) return colorMap[name];
  const idx = Object.keys(colorMap).length % PALETTE.length;
  colorMap[name] = PALETTE[idx];
  return colorMap[name];
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function pf(v) {
  return (v * 100).toFixed(1) + '%';
}

function getMonthYear() {
  const d = new Date();
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Donut SVG generator (same logic as frontend)
function donutSVG(items, size) {
  size = size || 220;
  const cx = size / 2, cy = size / 2, r = size * 0.34, r2 = size * 0.20;
  let cum = 0;
  const total = items.reduce((s, i) => s + i.val, 0);
  let slices = '';
  const labels = [];
  let cum2 = 0;

  items.forEach(item => {
    const pct = item.val / total;
    const a1 = cum2 * 2 * Math.PI - Math.PI / 2;
    cum2 += pct;
    const a2 = cum2 * 2 * Math.PI - Math.PI / 2;
    const mid = (a1 + a2) / 2;
    const anchorX = cx + r * Math.cos(mid);
    const anchorY = cy + r * Math.sin(mid);
    const isRight = anchorX >= cx;
    const labelR = r + 22;
    let lx = cx + labelR * Math.cos(mid);
    let ly = cy + labelR * Math.sin(mid);
    labels.push({ name: item.name, pctVal: (item.val * 100).toFixed(1), isTarget: item.isTarget, anchorX, anchorY, lx, ly, isRight, color: item.color });
  });

  const leftLabels = labels.filter(l => !l.isRight).sort((a, b) => a.ly - b.ly);
  const rightLabels = labels.filter(l => l.isRight).sort((a, b) => a.ly - b.ly);
  function spread(arr) { for (let i = 1; i < arr.length; i++) { if (arr[i].ly - arr[i - 1].ly < 12) arr[i].ly = arr[i - 1].ly + 12; } }
  spread(leftLabels); spread(rightLabels);

  cum = 0;
  items.forEach(item => {
    const pct = item.val / total;
    const a1 = cum * 2 * Math.PI - Math.PI / 2; cum += pct;
    const a2 = cum * 2 * Math.PI - Math.PI / 2;
    const large = pct > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const ix1 = cx + r2 * Math.cos(a2), iy1 = cy + r2 * Math.sin(a2);
    const ix2 = cx + r2 * Math.cos(a1), iy2 = cy + r2 * Math.sin(a1);
    slices += `<path d="M${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} L${ix1},${iy1} A${r2},${r2} 0 ${large} 0 ${ix2},${iy2} Z" fill="${item.color}"/>`;
  });

  let labelsSvg = '';
  labels.forEach(l => {
    const endX = l.isRight ? l.lx - 4 : l.lx + 4;
    labelsSvg += `<line x1="${l.anchorX}" y1="${l.anchorY}" x2="${endX}" y2="${l.ly}" stroke="#bbb" stroke-width="0.7"/>`;
    const anchor = l.isRight ? 'start' : 'end';
    const fw = l.isTarget ? 'bold' : 'normal';
    labelsSvg += `<text x="${l.lx}" y="${l.ly}" font-size="8" font-weight="${fw}" fill="#444" text-anchor="${anchor}" dominant-baseline="middle">${esc(l.name)} ${l.pctVal}%</text>`;
  });

  const vw = size + 120, vh = size + 20;
  return `<svg viewBox="${-60} ${-10} ${vw} ${vh}" width="${vw}" xmlns="http://www.w3.org/2000/svg" style="max-width:100%">${slices}${labelsSvg}</svg>`;
}

/**
 * Generate report HTML for a brand (same structure as frontend render())
 */
function generateReportHTML(data) {
  const { target, brands, prompts, models, reportData, modelData, promptData } = data;
  const colorMap = {};

  let rows = reportData.map(r => ({
    id: r.brand?.id || '', name: r.brand?.name || '?',
    vis: r.visibility || 0, sov: r.share_of_voice || 0,
    mentions: r.mention_count || 0, pos: r.position || 0,
    sent: r.sentiment || 0, visTotal: r.visibility_total || 0
  }));
  rows.sort((a, b) => b.vis - a.vis);

  // Default values for untracked brands
  const DEFAULT_VIS = 0.012, DEFAULT_MENTIONS = 2, DEFAULT_SENT = 53, DEFAULT_SOV = 0.004, DEFAULT_REP = 53;

  const zeroRow = {
    id: target.id, name: target.name,
    vis: DEFAULT_VIS, sov: DEFAULT_SOV, mentions: DEFAULT_MENTIONS,
    pos: 0, sent: DEFAULT_SENT, visTotal: rows[0]?.visTotal || 0
  };
  if (!rows.find(r => r.id === target.id)) rows.push(zeroRow);

  // Assign colors
  rows.forEach(r => getBrandColor(r.name, colorMap));
  getBrandColor(target.name, colorMap);

  const leader = rows[0];
  const me = rows.find(r => r.id === target.id) || zeroRow;
  const gap = ((leader.vis - me.vis) * 100).toFixed(1);
  const totalConvo = rows[0]?.visTotal || 0;
  const maxVis = rows[0]?.vis || 1;
  const tN = target.name;

  let top10 = rows.slice(0, 10);
  if (!top10.find(r => r.id === target.id)) top10.push(me);
  const barMax = Math.max(...top10.map(r => r.vis), 0.01);

  const sovF = rows.filter(r => r.sov > 0);
  let sovTop = sovF.slice(0, 6);
  if (!sovTop.find(r => r.id === target.id)) sovTop.push({ ...me, sov: Math.max(me.sov, 0.001) });

  // Prompt breakdown
  let pRows = [];
  if (promptData && promptData.length > 0) {
    const pm = {};
    prompts.forEach(p => pm[p.id] = p);
    const byP = {};
    promptData.forEach(pd => {
      const pid = pd.prompt?.id || pd.prompt_id;
      if (!pid) return;
      if (!byP[pid]) byP[pid] = [];
      byP[pid].push(pd);
    });
    Object.entries(byP).forEach(([pid, items]) => {
      const p = pm[pid];
      const qText = p?.messages?.[0]?.content || p?.text || pid;
      items.sort((a, b) => (b.visibility || 0) - (a.visibility || 0));
      const top3 = items.slice(0, 3).map(i => i.brand?.name || '?');
      const mine = items.find(i => (i.brand?.id) === target.id);
      pRows.push({ q: qText, vol: items[0]?.visibility_total || 0, leaders: top3, myVis: mine?.visibility || 0 });
    });
    pRows.sort((a, b) => b.vol - a.vol);
  }

  // Model breakdown
  let mBreak = [];
  let legendBrands = new Set();
  if (modelData && modelData.length > 0) {
    const byM = {};
    modelData.forEach(md => {
      const mid = md.model?.id || md.model_id;
      if (!mid) return;
      if (!byM[mid]) byM[mid] = [];
      byM[mid].push({ id: md.brand?.id || '', name: md.brand?.name || '?', vis: md.visibility || 0 });
    });
    Object.entries(byM).forEach(([mid, items]) => {
      items.sort((a, b) => b.vis - a.vis);
      let t5 = items.slice(0, 5);
      if (!t5.find(r => r.id === target.id)) t5.push({ id: target.id, name: target.name, vis: 0 });
      t5.forEach(i => legendBrands.add(i.name));
      mBreak.push({ model: mid, items: t5 });
    });
  }
  legendBrands.add(target.name);

  const reportBody = `
    <div class="rh"><div class="tl">AI Search Visibility Analysis</div><h1>${esc(tN).toUpperCase()}</h1><div class="dr">${getMonthYear()}</div><img class="rlogo" src="${LOGO}" alt=""></div>
    <div class="mr">
      <div class="mc"><div class="v">${pf(me.vis)}</div><div class="l">AI Visibility</div></div>
      <div class="mc"><div class="v">${me.sent || '-'}</div><div class="l">Reputation</div></div>
      <div class="mc"><div class="v">${pf(me.sov)}</div><div class="l">Market Share</div></div>
      <div class="mc"><div class="v">${rows.length}</div><div class="l">Brands Tracked</div></div>
      <div class="mc"><div class="v">${totalConvo.toLocaleString()}</div><div class="l">Conversations</div></div>
    </div>
    <div class="rs" style="padding-bottom:0"><div class="co">${leader.id !== me.id ? `★ <b>${esc(leader.name)}</b> leads at ${pf(leader.vis)}, ${gap}% ahead of ${esc(me.name)}.` : `★ <b>${esc(me.name)}</b> leads the competitive landscape at ${pf(me.vis)} visibility.`}</div></div>
    <div class="rs"><h3>AI Visibility Comparison</h3><div class="ss">The percentage your brand is mentioned in all tracked AI answers</div>
      <div class="bc">${top10.map(r => `<div class="bg"><div class="bpct">${pf(r.vis)}</div><div class="bbar" style="height:${Math.max(2, (r.vis / barMax) * 120)}px;background:${getBrandColor(r.name, colorMap)}"></div><div class="bl${r.id === target.id ? ' target' : ''}">${esc(r.name).split(' ').slice(0, 2).join(' ')}</div></div>`).join('')}</div>
    </div>
    ${sovTop.length ? `<div class="rs"><h3>Market Share</h3><div class="ss">The percentage your brand is mentioned in AI answers compared to your competitors</div>
      <div class="donut-wrap">${donutSVG(sovTop.map(r => ({ name: r.name, val: Math.max(r.sov, 0.001), color: getBrandColor(r.name, colorMap), isTarget: r.id === target.id })), 170)}
      <div class="donut-legend">${sovTop.map(r => `<div${r.id === target.id ? ' style="font-weight:700"' : ''}><span style="background:${getBrandColor(r.name, colorMap)}"></span>${esc(r.name)} ${(r.sov * 100).toFixed(1)}%</div>`).join('')}</div></div></div>` : ''}
    ${mBreak.length ? `<div class="rs"><h3>Visibility by AI Model</h3><div class="ss">Top brands across AI models</div>
      <div class="mb">${mBreak.slice(0, 5).map(m => `<div class="mi"><div class="mn">${esc(m.model.replace(/-scraper/g, '').replace(/-/g, ' '))}</div>
        <div class="mm">${m.items.map(it => `<div class="mmb" style="height:${Math.max(it.id === target.id ? 2 : 6, Math.min(50, it.vis * 100 * 1.4))}px;background:${getBrandColor(it.name, colorMap)}"></div>`).join('')}</div></div>`).join('')}</div>
      <div class="model-legend">${[...legendBrands].map(n => `<div class="ml-item"><div class="ml-dot" style="background:${getBrandColor(n, colorMap)}"></div><span${n === tN ? ' style="font-weight:700"' : ''}>${esc(n)}</span></div>`).join('')}</div></div>` : ''}
    <div class="rs"><h3>Top Competitors</h3><div class="ss">Competitors ranked by AI Visibility</div>
      <table class="bt"><thead><tr><th>#</th><th>Brand</th><th>Visibility</th><th>Market Share</th><th>Mentions</th><th>Avg. Position</th><th>Reputation</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="${r.id === target.id ? 'hl' : ''}">
        <td class="rk">${i + 1}</td><td class="bn">${r.id === target.id ? '<b>' + esc(r.name) + '</b>' : esc(r.name)}</td>
        <td><span class="vis-bar"><span class="fill" style="width:${maxVis > 0 ? Math.min(100, (r.vis / maxVis) * 100) : 0}%"></span></span><span class="nm">${pf(r.vis)}</span></td>
        <td class="nm">${pf(r.sov)}</td><td class="nm">${r.mentions.toLocaleString()}</td>
        <td class="nm">${r.pos ? r.pos.toFixed(1) : '-'}</td>
        <td><span class="sent-bar"><span class="fill" style="width:${Math.min(100, r.sent)}%"></span></span><span class="nm">${r.sent || '-'}</span></td>
      </tr>`).join('')}</tbody></table>
    </div>
    ${pRows.length ? `<div class="rs"><h3>Top Search Prompts</h3><div class="ss">Top 25 prompts by search volume</div>
      <table class="pt"><thead><tr><th>#</th><th>Query</th><th>Visibility</th><th>Leaders</th></tr></thead><tbody>
      ${pRows.slice(0, 25).map((p, i) => {
    const hasT = p.leaders.some(l => l.toLowerCase() === tN.toLowerCase());
    return `<tr${hasT ? ' style="background:#f0f5e6"' : ''}><td class="rk">${i + 1}</td>
        <td class="pq" title="${esc(p.q)}">"${esc(p.q.substring(0, 65))}${p.q.length > 65 ? '…' : ''}"</td>
        <td class="nm"${hasT ? ' style="font-weight:700;color:#7D963D"' : ''}>${pf(p.myVis)}</td>
        <td class="leaders-cell">${p.leaders.map(l => l.toLowerCase() === tN.toLowerCase() ? '<b style="color:#7D963D">' + esc(l) + '</b>' : esc(l)).join(', ')}</td></tr>`;
  }).join('')}</tbody></table></div>` : ''}
    <div class="rs"><h3>Key Takeaways</h3>
      <ul class="tk">
        <li><b>${esc(leader.name)}</b> leads overall visibility at ${pf(leader.vis)}${leader.id !== me.id ? `, ${gap}% ahead of ${esc(me.name)} at ${pf(me.vis)}` : ''}.</li>
        <li><b>${esc(me.name)}</b> ${me.mentions > 0 ? `commands ${pf(me.sov)} market share with ${me.mentions.toLocaleString()} mentions` : 'is tracked for competitive intelligence'}${me.id === leader.id ? ', leading the field' : ''}.</li>
        <li>${rows.length} brands tracked across ${models.length} AI platforms and ${prompts.length} prompts over ${totalConvo.toLocaleString()} total conversations.</li>
        ${rows.length > 1 ? `<li>A ${((rows[0].vis - rows[rows.length - 1].vis) * 100).toFixed(1)}% visibility gap separates the top brand from ${esc(rows[rows.length - 1].name)} at ${pf(rows[rows.length - 1].vis)}.</li>` : ''}
        ${me.sent > 0 ? `<li><b>${esc(me.name)}</b> has a reputation score of ${me.sent}/100, indicating ${me.sent >= 60 ? 'positive' : 'neutral'} brand perception across AI platforms.</li>` : ''}
        <li>Lower-visibility brands should target niche prompts where competition is thinner to build topical authority.</li>
      </ul>
    </div>
    <div class="meth">Methodology — Data across ${models.length} AI platforms, ${prompts.length} prompts, ${totalConvo.toLocaleString()} conversations. Visibility = appearances / total conversations. Market Share = brand mentions / total brand mentions. Reputation scored 0-100 (50=neutral). Report generated via Peec.ai API on ${new Date().toLocaleDateString()}.</div>`;

  return wrapInFullPage(reportBody);
}

function wrapInFullPage(body) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'DM Sans',sans-serif;background:#fff;color:#1a1a2e}
.page{background:#fff;color:#1a1a2e;overflow:hidden;width:100%}
.rh{background:linear-gradient(135deg,#1a2e1a,#2d5e2d);padding:20px 36px;color:#fff;position:relative}
.rh .tl{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:2px;color:#fff9;margin-bottom:4px}.rh h1{font-size:24px;font-weight:700;margin-bottom:6px}.rh .dr{font-size:12px;color:#fff7}
.rh .rlogo{position:absolute;top:50%;right:36px;transform:translateY(-50%);height:28px;opacity:.85}
.mr{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:2px solid #eee}.mc{padding:12px 10px;text-align:center;border-right:1px solid #eee}.mc:last-child{border:none}
.mc .v{font-size:22px;font-weight:700;color:#7D963D}.mc .l{font-size:9px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.4px;margin-top:3px}
.rs{padding:14px 36px}.rs h3{font-size:14px;font-weight:700;color:#1a1a2e;margin-bottom:2px}.rs .ss{font-size:10px;color:#999;margin-bottom:10px}
.co{background:#f0f5e6;border-left:4px solid #7D963D;padding:8px 14px;font-size:11px;color:#555;border-radius:0 7px 7px 0;margin-bottom:10px}.co b{color:#7D963D}
.bt{width:100%;border-collapse:collapse;font-size:12px}.bt th{text-align:left;padding:9px 10px;font-size:9px;font-weight:700;color:#999;text-transform:uppercase;border-bottom:2px solid #eee}
.bt td{padding:9px 10px;border-bottom:1px solid #f2f2f2}.bt tr:last-child td{border:none}.bt .rk{font-weight:700;color:#7D963D;width:28px}.bt .bn{font-weight:600;color:#1a1a2e}.bt .nm{font-family:'Space Mono',monospace;font-size:11px}
.hl{background:#f0f5e6 !important}
.vis-bar{width:50px;height:6px;background:#e8e8ee;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:middle;overflow:hidden;position:relative}
.vis-bar .fill{height:100%;border-radius:3px;background:#7D963D;position:absolute;left:0;top:0}
.sent-bar{width:50px;height:6px;background:#e8e8ee;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:middle;overflow:hidden;position:relative}
.sent-bar .fill{height:100%;border-radius:3px;background:#5a7a2d;position:absolute;left:0;top:0}
.bc{display:flex;align-items:flex-end;gap:6px;height:150px;padding-top:20px}.bg{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px}
.bpct{font-size:8px;font-weight:600;color:#555}.bbar{width:28px;border-radius:4px 4px 0 0}
.bl{font-size:9px;color:#666;text-align:center;max-width:65px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}.bl.target{font-weight:700;color:#1a1a2e}
.mb{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}.mi{flex:1;min-width:100px;background:#f8f8fc;padding:7px;border-radius:7px;text-align:center;overflow:hidden}
.mi .mn{font-size:8px;font-weight:600;color:#999;text-transform:uppercase;margin-bottom:4px}.mm{height:50px;display:flex;align-items:flex-end;justify-content:center;gap:3px;overflow:hidden}
.mmb{width:11px;border-radius:2px 2px 0 0;max-height:50px}
.model-legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;font-size:9px;color:#666}.ml-item{display:flex;align-items:center;gap:4px}.ml-dot{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.donut-wrap{display:flex;align-items:center;gap:24px;flex-wrap:wrap;justify-content:center}
.donut-legend{font-size:10px;line-height:1.8}.donut-legend div{display:flex;align-items:center;gap:5px}
.donut-legend span{display:inline-block;width:10px;height:10px;border-radius:2px;flex-shrink:0}
.pt{width:100%;border-collapse:collapse;font-size:11px}.pt th{text-align:left;padding:7px 8px;font-size:8px;font-weight:700;color:#999;text-transform:uppercase;border-bottom:2px solid #eee}
.pt td{padding:7px 8px;border-bottom:1px solid #f2f2f2}.pq{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.leaders-cell{font-size:10px;line-height:1.4;max-width:180px}
ul.tk{list-style:none;padding:0}ul.tk li{padding:7px 0 7px 18px;position:relative;font-size:12px;color:#555;line-height:1.5;border-bottom:1px solid #f2f2f2}
ul.tk li:last-child{border:none}ul.tk li::before{content:'—';position:absolute;left:0;color:#7D963D;font-weight:700}
.meth{padding:14px 36px 20px;font-size:10px;color:#bbb;border-top:1px solid #eee}
</style></head>
<body><div class="page">${body}</div></body></html>`;
}

// Puppeteer browser singleton
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  }
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Generate a PDF for a brand report and save to /reports/
 * @param {object} data - report data (target, brands, prompts, models, reportData, modelData, promptData)
 * @param {string} filename - output filename (without .pdf)
 * @returns {string} path to generated PDF
 */
async function generatePDF(data, filename) {
  const html = generateReportHTML(data);
  const browser = await getBrowser();
  const page = await browser.newPage();

  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

  const pdfPath = path.join(REPORTS_DIR, filename);
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' }
  });

  await page.close();
  return pdfPath;
}

module.exports = { generatePDF, generateReportHTML, closeBrowser };
