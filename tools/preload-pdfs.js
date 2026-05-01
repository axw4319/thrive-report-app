#!/usr/bin/env node
// Pre-generate all PDFs by hitting each brand's report URL
// Usage: node tools/preload-pdfs.js [base-url] [--start N]
//   --start N: skip the first N brands (use to resume an interrupted run)

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fetch = require('node-fetch');
const { PeecAPI } = require('../lib/peec-api');

const args = process.argv.slice(2);
const startFlagIdx = args.indexOf('--start');
const START_FROM = startFlagIdx !== -1 ? parseInt(args[startFlagIdx + 1], 10) : 0;
const BASE_URL = (args[0] && !args[0].startsWith('--')) ? args[0] : 'http://localhost:3000';
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
  const totalBrands = brandList.length;
  if (START_FROM > 0) {
    console.log(`\nResuming from brand ${START_FROM + 1}/${totalBrands} (skipping first ${START_FROM})\n`);
    brandList.splice(0, START_FROM);
  } else {
    console.log(`\n${totalBrands} unique brands to pre-generate\n`);
  }

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
          const pos = START_FROM + done;
          console.log(`  ✅ [${pos}/${totalBrands}] ${brand} (${label})`);
        } else {
          errors++;
          const pos = START_FROM + done + errors;
          console.log(`  ❌ [${pos}/${totalBrands}] ${brand}: HTTP ${res.status}`);
        }
      } catch (e) {
        errors++;
        const pos = START_FROM + done + errors;
        console.log(`  ❌ [${pos}/${totalBrands}] ${brand}: ${e.message}`);
      }
    });
    await Promise.all(promises);
    if (i + CONCURRENCY < brandList.length) await sleep(DELAY_MS);
  }

  console.log(`\nDone! ${done} OK (${skipped} cached, ${done - skipped} generated), ${errors} errors\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
