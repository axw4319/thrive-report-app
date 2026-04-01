#!/usr/bin/env node
// Pre-generate all PDFs by hitting each brand's report URL
// Usage: node tools/preload-pdfs.js [base-url]
// Example: node tools/preload-pdfs.js https://thrive-report-app.onrender.com

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fetch = require('node-fetch');

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const API_KEY = process.env.PEEC_API_KEY;
const PEEC_BASE = 'https://api.peec.ai/customer/v1';
const CONCURRENCY = 3; // parallel PDF generations
const DELAY_MS = 1000; // delay between batches

async function peecGet(path) {
  const res = await fetch(`${PEEC_BASE}/${path}`, {
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY }
  });
  return res.json();
}

function toFilename(name) {
  return 'AI_Visibility_Analysis_-_' + name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '') + '.pdf';
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!API_KEY) { console.error('PEEC_API_KEY not set'); process.exit(1); }

  console.log(`\nFetching projects from Peec API...`);
  const projects = await peecGet('projects');
  console.log(`Found ${projects.length} projects\n`);

  const allBrands = new Set();

  for (const proj of projects) {
    const pid = proj.id || proj.project_id;
    const pname = proj.name || pid;
    try {
      const brands = await peecGet(`projects/${pid}/brands`);
      console.log(`  ${pname}: ${brands.length} brands`);
      for (const b of brands) {
        allBrands.add(b.name);
      }
    } catch (e) {
      console.log(`  ${pname}: error fetching brands - ${e.message}`);
    }
  }

  const brandList = [...allBrands].sort();
  console.log(`\n${brandList.length} unique brands to pre-generate\n`);

  let done = 0;
  let errors = 0;

  // Process in batches
  for (let i = 0; i < brandList.length; i += CONCURRENCY) {
    const batch = brandList.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (brand) => {
      const filename = toFilename(brand);
      const url = `${BASE_URL}/reports/${encodeURIComponent(filename)}`;
      try {
        const start = Date.now();
        const res = await fetch(url, { timeout: 60000 });
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        if (res.ok) {
          done++;
          console.log(`  ✅ [${done}/${brandList.length}] ${brand} (${elapsed}s)`);
        } else {
          errors++;
          console.log(`  ❌ [${done + errors}/${brandList.length}] ${brand}: HTTP ${res.status}`);
        }
      } catch (e) {
        errors++;
        console.log(`  ❌ [${done + errors}/${brandList.length}] ${brand}: ${e.message}`);
      }
    });
    await Promise.all(promises);
    if (i + CONCURRENCY < brandList.length) await sleep(DELAY_MS);
  }

  console.log(`\nDone! ${done} generated, ${errors} errors\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
