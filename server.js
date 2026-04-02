require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
// CSV bulk processing runs locally via run-csv.js, not on the server

const crypto = require('crypto');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Authentication ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'thrive2026';
const AUTH_COOKIE = 'pc_auth';
const AUTH_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year

function makeToken(password) {
  return crypto.createHmac('sha256', 'thrive-salt').update(password).digest('hex');
}

function isAuthed(req) {
  const cookie = (req.headers.cookie || '').split(';').find(c => c.trim().startsWith(AUTH_COOKIE + '='));
  if (!cookie) return false;
  return cookie.split('=')[1]?.trim() === makeToken(ADMIN_PASSWORD);
}

// Login page
app.get('/login', (req, res) => {
  const error = req.query.error ? '<div style="color:#ff5e6e;margin-bottom:16px;font-size:13px">Incorrect password</div>' : '';
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Login — Thrive</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',sans-serif;background:#07070d;color:#e0e0f0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#111119;border:1px solid #282840;border-radius:14px;padding:36px;width:340px;text-align:center}
h1{font-size:18px;font-weight:700;margin-bottom:6px}p{font-size:12px;color:#7878a0;margin-bottom:24px}
input{width:100%;background:#07070d;border:1px solid #282840;border-radius:7px;padding:12px 14px;color:#e0e0f0;font-family:'DM Sans',sans-serif;font-size:14px;outline:none;margin-bottom:16px}
input:focus{border-color:#FF6600}
button{width:100%;padding:13px;background:linear-gradient(135deg,#FF6600,#FF8C33);border:none;border-radius:9px;color:#fff;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;cursor:pointer}
button:hover{transform:translateY(-1px);box-shadow:0 6px 24px #FF660055}</style></head>
<body><div class="card"><h1>Thrive</h1><p>Enter password to access the dashboard</p>${error}
<form method="POST" action="/login"><input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Sign In</button></form></div></body></html>`);
});

app.post('/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${makeToken(ADMIN_PASSWORD)}; Path=/; Max-Age=${AUTH_MAX_AGE / 1000}; HttpOnly; SameSite=Lax`);
    res.redirect(req.query.next || '/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; Max-Age=0`);
  res.redirect('/login');
});

// Protect everything EXCEPT /reports/ PDFs and /login
app.use((req, res, next) => {
  // Allow PDF report URLs without auth
  if (req.path.startsWith('/reports/')) return next();
  // Allow login routes
  if (req.path === '/login') return next();
  // Allow proxy for frontend API calls (already behind auth pages)
  if (req.path === '/proxy') return next();
  // Allow CSV API endpoint
  if (req.path === '/api/csv/process') return next();
  // Everything else requires auth
  if (!isAuthed(req)) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Serve generated PDF reports — on-demand generation
const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const { PeecAPI, getDates } = require('./lib/peec-api');
const { matchBrand } = require('./lib/fuzzy');
const { generatePDF, closeBrowser, getBrowser } = require('./lib/pdf-generator');

// URL format: /reports/AI_Visibility_Analysis_-_Company_Name.pdf
app.get('/reports/:filename', async (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  if (!filename.endsWith('.pdf')) return res.status(400).send('Invalid file');
  const filePath = path.join(REPORTS_DIR, filename);

  // Serve cached PDF if it exists, otherwise generate on-demand
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  // Extract company name from "AI_Visibility_Analysis_-_Company_Name.pdf"
  const companySlug = filename.replace('.pdf', '').replace(/^AI_Visibility_Analysis_-_/, '');
  const apiKey = process.env.PEEC_API_KEY;
  if (!apiKey) return res.status(500).send('No API key configured');

  const projectIds = [
    'or_be4b66ba-1ddb-43dc-bafd-bcd28fb1b842', // M&A Banks 2
  ];

  try {
    const api = new PeecAPI(apiKey);

    // Find brand using fuzzy matching (same logic as CSV processor)
    let targetBrand = null;
    let targetPid = projectIds[0];
    let projectBrands = [];
    let reportData = [];
    const companyName = companySlug.replace(/_/g, ' ');

    for (const pid of projectIds) {
      const brands = await api.getBrands(pid);
      // First try exact slug match
      for (const b of brands) {
        const slug = b.name.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_').toLowerCase();
        if (slug === companySlug) {
          targetBrand = b;
          targetPid = pid;
          break;
        }
      }
      // If no exact match, try fuzzy matching
      if (!targetBrand) {
        const fuzzyMatch = matchBrand(companyName, brands);
        if (fuzzyMatch) {
          targetBrand = fuzzyMatch.brand;
          targetPid = pid;
        }
      }
      if (targetBrand) {
        projectBrands = brands;
        break;
      }
    }

    // Fetch all data for the target project in parallel
    let dateBody = getDates(7);
    const [brandsRes, prompts, models, reportRes] = await Promise.all([
      projectBrands.length ? Promise.resolve(projectBrands) : api.getBrands(targetPid),
      api.getPrompts(targetPid),
      api.getModels(targetPid),
      api.getBrandReport(targetPid, dateBody)
    ]);
    projectBrands = brandsRes;
    reportData = reportRes;
    if (!reportData.length) {
      dateBody = {};
      reportData = await api.getBrandReport(targetPid, dateBody);
    }
    // Fetch model and prompt breakdowns in parallel
    let modelData = [], promptData = [];
    const [md, pd] = await Promise.all([
      api.getBrandReportByModel(targetPid, dateBody).catch(() => []),
      api.getBrandReportByPrompt(targetPid, dateBody).catch(() => [])
    ]);
    modelData = md;
    promptData = pd;

    // If no brand matched, create a virtual one from the slug
    if (!targetBrand) {
      const prettyName = companySlug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      targetBrand = { id: '__ondemand__' + companySlug, name: prettyName };
    }

    console.log(`[PDF] Generating on-demand: ${targetBrand.name} -> ${filename}`);
    await generatePDF({
      target: targetBrand,
      brands: projectBrands,
      prompts, models, reportData, modelData, promptData
    }, filename);

    res.sendFile(filePath);
  } catch (e) {
    console.error(`[PDF] Error generating ${filename}:`, e.message);
    res.status(500).send('Error generating report: ' + e.message);
  }
});

const BASE = 'https://api.peec.ai/customer/v1';

// ── Existing proxy endpoint ──
app.post('/proxy', async (req, res) => {
  const { method = 'GET', apiPath, query = {}, body: reqBody, apiKey } = req.body || {};
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE}/${apiPath}${qs ? '?' + qs : ''}`;
  console.log(`[PROXY] ${method} ${url}`);
  // Debug: log full request details for reports calls
  if (apiPath && apiPath.includes('reports')) {
    console.log(`  [DEBUG] apiKey: ${(apiKey||'').slice(0,30)}...`);
    console.log(`  [DEBUG] query: ${JSON.stringify(query)}`);
    console.log(`  [DEBUG] body: ${JSON.stringify(reqBody)}`);
  }

  try {
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiKey || '' };
    const opts = { method, headers };
    if (method === 'POST' && reqBody) opts.body = JSON.stringify(reqBody);

    const r = await fetch(url, opts);
    const text = await r.text();
    console.log(`  => ${r.status} (${text.slice(0, 200)})`);

    try {
      const data = JSON.parse(text);
      return res.status(r.status).json(data);
    } catch {
      return res.status(r.status).json({ error: text.trim() || `HTTP ${r.status}`, status: r.status });
    }
  } catch (e) {
    console.error(`  ERR: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

// ── CSV Bulk Enrichment (data only, no PDF generation — PDFs are on-demand) ──
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const DEFAULTS = { visibility: 0.012, mentions: 2, sentiment: 53, market_share: 0.004, reputation: 53 };
const CSV_PROJECT_DEFAULT = 'or_be4b66ba-1ddb-43dc-bafd-bcd28fb1b842'; // M&A Banks 2

app.post('/api/csv/process', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });
  const apiKey = req.body.apiKey || process.env.PEEC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  const CSV_PROJECT = req.body.projectId || CSV_PROJECT_DEFAULT;

  try {
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const api = new PeecAPI(apiKey);

    // Parse CSV
    let records;
    const fileName = req.file.originalname || 'file.csv';
    if (fileName.match(/\.xlsx?$/i)) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      records = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
    } else {
      records = parse(req.file.buffer, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
    }
    const openRows = records.filter(r => (r['Open/Closed'] || '').toString().trim().toUpperCase() === 'TRUE');

    // Fetch brands + report data
    const brands = await api.getBrands(CSV_PROJECT);
    let reportData = await api.getBrandReport(CSV_PROJECT, getDates(7));
    if (!reportData.length) reportData = await api.getBrandReport(CSV_PROJECT, {});

    // Match companies
    const companyMatches = new Map();
    const uniqueCompanies = [...new Set(openRows.map(r => r.current_company).filter(Boolean))];
    for (const c of uniqueCompanies) {
      const m = matchBrand(c, brands);
      if (m) companyMatches.set(c, m);
    }

    function toFilename(c) {
      return 'AI_Visibility_Analysis_-_' + c.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_').toLowerCase() + '.pdf';
    }
    function fmt3(rd, exId, f) {
      const s = [...rd].filter(r => r.brand?.id !== exId).sort((a, b) => (b[f] || 0) - (a[f] || 0)).slice(0, 3);
      if (!s.length) return '';
      const p = s.map(r => r.brand?.name + ' at ' + ((r[f] || 0) * 100).toFixed(1) + '%');
      return p.length === 1 ? p[0] : p.length === 2 ? p[0] + ' and ' + p[1] : p.slice(0, -1).join(', ') + ', and ' + p[p.length - 1];
    }

    // Build enriched rows (NO PDF generation)
    const enrichedRows = [];
    for (const row of openRows) {
      const c = row.current_company || '';
      if (!c) continue;
      const m = companyMatches.get(c);
      let vis = DEFAULTS.visibility, men = DEFAULTS.mentions, sen = DEFAULTS.sentiment, ms = DEFAULTS.market_share, rep = DEFAULTS.reputation;
      if (m) {
        const br = reportData.find(r => r.brand?.id === m.brand.id);
        if (br) { vis = br.visibility || vis; men = br.mention_count || men; sen = br.sentiment || sen; ms = br.share_of_voice || ms; rep = br.sentiment || rep; }
      }
      const exId = m ? m.brand.id : null;
      enrichedRows.push({
        first_name: row.first_name || '', last_name: row.last_name || '',
        current_company: c, current_company_position: row.current_company_position || '',
        profile_url: row.profile_url || '', 'Open/Closed': row['Open/Closed'] || '',
        Visibility: ((vis * 100).toFixed(1)) + '%',
        'Top Competitors Visibility': fmt3(reportData, exId, 'visibility'),
        'Top Competitors Market Share': fmt3(reportData, exId, 'share_of_voice'),
        'Report Link': baseUrl + '/reports/' + encodeURIComponent(toFilename(c)),
        Mentions: men, 'Market Share': ((ms * 100).toFixed(1)) + '%',
        Sentiment: sen, Reputation: rep
      });
    }

    // Sort by visibility descending
    enrichedRows.sort((a, b) => parseFloat(b.Visibility) - parseFloat(a.Visibility));

    // Build CSV string
    const headers = ['first_name', 'last_name', 'current_company', 'current_company_position', 'profile_url', 'Open/Closed', 'Visibility', 'Top Competitors Visibility', 'Top Competitors Market Share', 'Report Link', 'Mentions', 'Market Share', 'Sentiment', 'Reputation'];
    const csvLines = [headers.join(',')];
    for (const row of enrichedRows) {
      csvLines.push(headers.map(h => { const v = String(row[h] || ''); return (v.includes(',') || v.includes('"') || v.includes('\n')) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','));
    }

    // Use uploaded filename as base for download name
    const origName = (req.file.originalname || 'results').replace(/\.(csv|xlsx?)$/i, '');
    const dlName = origName + ' - AI Visibility Reports.csv';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`);
    res.send(csvLines.join('\n'));

    // Background: pre-generate all PDFs so they're instant when clicked
    const pdfCompanies = [...new Set(enrichedRows.map(r => r['Report Link']).filter(Boolean))];
    if (pdfCompanies.length) {
      console.log(`[CSV] Pre-generating ${pdfCompanies.length} PDFs in background...`);
      (async () => {
        let ok = 0, err = 0;
        for (const link of pdfCompanies) {
          try {
            const pdfUrl = link.startsWith('http') ? link : `${baseUrl}${link}`;
            const r = await fetch(pdfUrl, { timeout: 60000 });
            if (r.ok) ok++;
            else err++;
          } catch (e) { err++; }
        }
        console.log(`[CSV] PDF pre-generation done: ${ok} OK, ${err} errors`);
      })().catch(e => console.error('[CSV] PDF pre-generation error:', e.message));
    }
  } catch (e) {
    console.error('[CSV] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ✅  http://localhost:${PORT}\n`);
  // Pre-warm Puppeteer browser so first PDF request is fast
  getBrowser().then(() => console.log('  🚀  Puppeteer browser pre-warmed')).catch(() => {});
});
