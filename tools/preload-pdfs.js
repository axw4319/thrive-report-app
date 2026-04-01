#!/usr/bin/env node
// Pre-generate all PDFs by hitting each brand's report URL
// Usage: node tools/preload-pdfs.js [base-url]

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fetch = require('node-fetch');
const { PeecAPI } = require('../lib/peec-api');

const BASE_URL = process.argv[2] || 'http://localhost:3000';
const API_KEY = process.env.PEEC_API_KEY;
const CONCURRENCY = 3;
const DELAY_MS = 1000;

function toFilename(name) {
  return 'AI_Visibility_Analysis_-_' + name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '') + '.pdf';
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!API_KEY) { console.error('PEEC_API_KEY not set'); process.exit(1); }

  const api = new PeecAPI(API_KEY);

  console.log(`\nFetching projects...`);
  const projects = await api.getProjects();
  console.log(`Found ${projects.length} projects\n`);

  const allBrands = new Set();

  for (const proj of projects) {
    const pid = proj.id;
    const pname = proj.name || pid;
    try {
      const brands = await api.getBrands(pid);
      console.log(`  ${pname}: ${brands.length} brands`);
      for (const b of brands) {
        if (b.name) allBrands.add(b.name);
      }
    } catch (e) {
      console.log(`  ${pname}: error - ${e.message}`);
    }
  }

  const brandList = [...allBrands].sort();
  console.log(`\n${brandList.length} unique brands to pre-generate\n`);

  let done = 0;
  let skipped = 0;
  let errors = 0;

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
          const label = elapsed < 1 ? 'cached' : `${elapsed}s`;
          done++;
          if (elapsed < 1) skipped++;
          console.log(`  ✅ [${done}/${brandList.length}] ${brand} (${label})`);
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

  console.log(`\nDone! ${done} OK (${skipped} cached, ${done - skipped} generated), ${errors} errors\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
