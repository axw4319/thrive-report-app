require('dotenv').config();
const express = require('express');
const path = require('path');
const db = require('./database');
const { scrapeWebsite, analyzeWebsite } = require('./lib/scraper');
const { generatePrompts } = require('./lib/prompt-generator');
const { queryAll, getModelNames, clients } = require('./lib/ai-clients');
const { extractBrands, extractBrandsBatch } = require('./lib/brand-extractor');
const { calculateMetrics } = require('./lib/metrics-calculator');
const { assembleReport } = require('./lib/report-data');
const { findFuzzyMatch } = require('./lib/prompt-matcher');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Purge expired cache on startup
db.purgeExpiredCache.run();

// --- Scan Pipeline (runs async) ---
async function runScan(scanId) {
  try {
    const scan = db.getScan.get(scanId);
    if (!scan) return;

    // Step 1: Scrape website
    console.log(`[SCAN ${scanId}] Scraping ${scan.website_url}...`);
    db.updateScanStatus.run('scraping', 'Scraping website...', scanId);
    const scraped = await scrapeWebsite(scan.website_url);

    // Step 2: Analyze website
    console.log(`[SCAN ${scanId}] Analyzing website...`);
    db.updateScanStatus.run('analyzing', 'Analyzing website content...', scanId);
    const profile = await analyzeWebsite(scraped, scan.brand_name);
    const industry = (profile.industry || '').toLowerCase().trim();
    db.updateScan.run(
      profile.industry || '', JSON.stringify(profile.services || []),
      profile.location || '', profile.target_market || '',
      profile.summary || '', 'generating_prompts', 'Generating search prompts...', scanId
    );

    // Step 3: Generate prompts (check industry cache first, incorporate clusters)
    console.log(`[SCAN ${scanId}] Generating prompts...`);
    const clusters = (scan.prompt_clusters || '').trim();
    let prompts;
    // Skip industry cache if custom clusters were provided (they make prompts unique)
    const cachedPrompts = (industry && !clusters) ? db.getCachedPrompts.get(industry) : null;
    if (cachedPrompts) {
      prompts = JSON.parse(cachedPrompts.prompts_json);
      console.log(`[SCAN ${scanId}] Using cached prompts for industry "${industry}" (${prompts.length} prompts)`);
    } else {
      prompts = await generatePrompts(profile, scan.brand_name, clusters);
      if (industry && !clusters) {
        db.upsertCachedPrompts.run(industry, JSON.stringify(prompts));
      }
    }
    for (const p of prompts) {
      db.insertPrompt.run(scanId, p.prompt, p.category);
    }
    console.log(`[SCAN ${scanId}] ${prompts.length} prompts ready`);

    // Step 4: Query AI models (with response cache)
    const savedPrompts = db.getPrompts.all(scanId);
    const total = savedPrompts.length;
    const modelNames = clients.map(c => c.name);

    const MODEL_DISPLAY = {chatgpt:'ChatGPT',gemini:'Gemini',perplexity:'Perplexity',google_ai_overview:'Google AI Overview'};

    for (let i = 0; i < savedPrompts.length; i++) {
      const p = savedPrompts[i];

      // Check cache for each model, try fuzzy match if no exact hit
      const cachedResults = [];
      const uncachedClients = [];

      // Try fuzzy match once per prompt (shared across models)
      const fuzzyPrompt = findFuzzyMatch(p.prompt_text, db.db);

      for (const client of clients) {
        let cached = db.getCachedResponse.get(p.prompt_text, client.name);
        if (!cached && fuzzyPrompt) {
          cached = db.getCachedResponse.get(fuzzyPrompt, client.name);
          if (cached) console.log(`[SCAN ${scanId}]   Fuzzy match for ${client.name}: "${p.prompt_text.slice(0,40)}..." → "${fuzzyPrompt.slice(0,40)}..."`);
        }
        if (cached) {
          cachedResults.push({
            model_name: client.name,
            response: cached.response,
            brands: cached.brands_json ? JSON.parse(cached.brands_json) : null,
            fromCache: true
          });
        } else {
          uncachedClients.push(client);
        }
      }

      const promptSnip = p.prompt_text.slice(0, 50);

      if (cachedResults.length > 0) {
        console.log(`[SCAN ${scanId}]   Cache hit: ${cachedResults.map(r => r.model_name).join(', ')}`);
      }

      // Query uncached models in parallel, updating progress as each completes
      let freshResults = [];
      if (uncachedClients.length > 0) {
        const completed = new Set();
        const updateProgress = (modelName) => {
          completed.add(modelName);
          const remaining = uncachedClients.filter(c => !completed.has(c.name)).map(c => MODEL_DISPLAY[c.name] || c.name);
          const msg = remaining.length > 0
            ? `(${i+1}/${total}) Querying ${remaining.join(', ')} — "${promptSnip}..."`
            : `(${i+1}/${total}) Extracting brands — "${promptSnip}..."`;
          db.updateScanStatus.run('querying', msg, scanId);
        };

        // Set initial progress showing first model being queried
        const allNames = uncachedClients.map(c => MODEL_DISPLAY[c.name] || c.name);
        const initMsg = `(${i+1}/${total}) Querying ${allNames.join(', ')} — "${promptSnip}..."`;
        console.log(`[SCAN ${scanId}] ${initMsg}`);
        db.updateScanStatus.run('querying', initMsg, scanId);

        freshResults = await Promise.allSettled(
          uncachedClients.map(client =>
            client.query(p.prompt_text).then(
              response => { updateProgress(client.name); return { model_name: client.name, response, fromCache: false }; },
              err => {
                console.error(`  [${client.name}] Error: ${err.message}`);
                updateProgress(client.name);
                return { model_name: client.name, response: null, error: err.message, fromCache: false };
              }
            )
          )
        );
        freshResults = freshResults.map(r => r.value);
      } else {
        const msg = `(${i+1}/${total}) Using cached data — "${promptSnip}..."`;
        console.log(`[SCAN ${scanId}] ${msg}`);
        db.updateScanStatus.run('querying', msg, scanId);
      }

      const allResults = [...cachedResults, ...freshResults];

      // Process cached results (brands already extracted)
      for (const r of allResults.filter(r => r.fromCache && r.brands && r.response)) {
        const respId = db.insertResponse.run(p.id, r.model_name, r.response).lastInsertRowid;
        for (const b of r.brands) {
          db.insertMention.run(respId, b.brand_name, b.normalized_name, b.position, b.context_snippet, b.sentiment_score);
        }
      }

      // Batch extract brands from uncached responses (single API call)
      const uncachedWithResponses = allResults.filter(r => !r.fromCache && r.response);
      if (uncachedWithResponses.length > 0) {
        const brandsByModel = await extractBrandsBatch(uncachedWithResponses, p.prompt_text);
        for (const r of uncachedWithResponses) {
          const respId = db.insertResponse.run(p.id, r.model_name, r.response).lastInsertRowid;
          const brands = brandsByModel[r.model_name] || [];
          // Cache the response + extracted brands
          db.upsertCachedResponse.run(p.prompt_text, r.model_name, r.response, JSON.stringify(brands));
          for (const b of brands) {
            db.insertMention.run(respId, b.brand_name, b.normalized_name, b.position, b.context_snippet, b.sentiment_score);
          }
        }
      }

      // Save responses with no content (null) so they're tracked
      for (const r of allResults.filter(r => !r.fromCache && !r.response)) {
        if (!r.fromCache) db.insertResponse.run(p.id, r.model_name, null);
      }
    }

    // Step 6: Calculate metrics
    console.log(`[SCAN ${scanId}] Calculating metrics...`);
    db.updateScanStatus.run('calculating', 'Calculating visibility metrics...', scanId);
    calculateMetrics(scanId);

    // Done
    db.completeScan.run(scanId);
    console.log(`[SCAN ${scanId}] Complete!`);

    // Background pre-warm: pre-query uncached prompts for this industry
    // This runs after the scan is done so it doesn't slow down the user
    if (industry) {
      prewarmIndustry(industry, prompts).catch(err =>
        console.error(`[PREWARM] Error for "${industry}":`, err.message)
      );
    }

  } catch (err) {
    console.error(`[SCAN ${scanId}] Error:`, err.message);
    db.updateScanStatus.run('error', err.message, scanId);
  }
}

// Background pre-warming: query AI models for any prompts not yet cached
async function prewarmIndustry(industry, prompts) {
  let warmed = 0;
  for (const p of prompts) {
    for (const client of clients) {
      const cached = db.getCachedResponse.get(p.prompt, client.name);
      if (!cached) {
        try {
          const response = await client.query(p.prompt);
          if (response) {
            const brands = await extractBrands(response, p.prompt);
            db.upsertCachedResponse.run(p.prompt, client.name, response, JSON.stringify(brands));
            warmed++;
          }
        } catch (err) {
          // Silently skip failed pre-warm queries
        }
      }
    }
  }
  if (warmed > 0) console.log(`[PREWARM] Cached ${warmed} new responses for "${industry}"`);
}

// --- API Routes ---
app.post('/api/scan/start', (req, res) => {
  const { brand_name, prompt_clusters } = req.body;
  let { website_url } = req.body;
  if (!brand_name || !website_url) return res.status(400).json({ error: 'brand_name and website_url required' });
  if (!/^https?:\/\//i.test(website_url)) website_url = 'https://' + website_url;

  const result = db.createScan.run(brand_name, website_url, prompt_clusters || '');
  const scanId = result.lastInsertRowid;

  // Run async — don't await
  runScan(scanId);

  res.json({ scan_id: scanId, status: 'pending' });
});

app.get('/api/scan/:id/status', (req, res) => {
  const scan = db.getScan.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  res.json({ id: scan.id, status: scan.status, progress: scan.progress, brand_name: scan.brand_name });
});

app.get('/api/scan/:id/report', (req, res) => {
  const report = assembleReport(Number(req.params.id));
  if (!report) return res.status(404).json({ error: 'Report not found' });
  res.json(report);
});

app.get('/api/scans', (req, res) => {
  res.json(db.getAllScans.all());
});

app.delete('/api/scan/:id', (req, res) => {
  db.deleteScan.run(req.params.id);
  res.json({ ok: true });
});

// CSV export for cold outreach
app.get('/api/scan/:id/csv', (req, res) => {
  const report = assembleReport(Number(req.params.id));
  if (!report) return res.status(404).json({ error: 'Report not found' });

  const rows = [['Rank', 'Brand', 'Visibility %', 'Market Share %', 'Avg Position', 'Mentions', 'Reputation', 'Industry', 'Scan Date']];
  report.metrics.forEach((b, i) => {
    const rep = Math.round(((b.avg_sentiment + 1) / 2) * 100);
    rows.push([
      i + 1, `"${b.brand_name}"`, b.visibility_pct, b.market_share_pct,
      b.avg_rank.toFixed(1), b.mention_count, rep,
      `"${report.scan.industry || ''}"`, `"${report.scan.created_at}"`
    ]);
  });

  const csv = rows.map(r => r.join(',')).join('\n');
  const brand = report.scan.brand_name.replace(/[^a-zA-Z0-9]/g, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="AI_Visibility_${brand}.csv"`);
  res.send(csv);
});

// Shareable report HTML page
app.get('/report/:id', (req, res) => {
  const report = assembleReport(Number(req.params.id));
  if (!report) return res.status(404).send('Report not found');
  // Serve the main page with auto-load script
  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Visibility Report - ${report.scan.brand_name}</title>
<meta property="og:title" content="AI Visibility Report - ${report.scan.brand_name}">
<meta property="og:description" content="${report.scan.brand_name} AI visibility: ${report.target.visibility_pct}% across ${report.models.length} AI platforms">
<script>window.__REPORT_DATA=${JSON.stringify(report)};window.__REPORT_ID=${req.params.id};</script>
</head><body><script>window.location.href='/?view=${req.params.id}';</script></body></html>`);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`\n  ✅  http://localhost:${PORT}\n`));
