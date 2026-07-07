#!/usr/bin/env node
// CLI runner for the live-AI CSV pipeline.
// Usage:
//   node tools/live-csv/run.js --input INPUT.csv --output OUTPUT.xlsx [--limit N] [--filter "Houston"] [--no-pdfs]
//
// Input columns expected (case-insensitive, also accepts 'Area' for city):
//   Company Name | Phone Number | Website | Email | Area
//
// Outputs:
//   - OUTPUT.xlsx with two sheets: "Companies" (enriched per-row) and "Groups" (one row per city×industry group, lists prompts)
//   - PDFs in reports/ unless --no-pdfs

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const { processRows, classifyOnly } = require('../../lib/live-engine/csv-pipeline');

function parseArgs(argv) {
  const out = {
    limit: null,
    filter: null,
    baseUrl: process.env.BASE_URL || 'https://thrive-report-app.onrender.com',
    generatePdfs: true,
    classifyOnly: false,
    overridesPath: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i];
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--filter') out.filter = argv[++i];
    else if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--no-pdfs') out.generatePdfs = false;
    else if (a === '--classify-only') out.classifyOnly = true;
    else if (a === '--overrides') out.overridesPath = argv[++i];
    else if (a === '--pdf-concurrency') out.pdfConcurrency = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  if (!out.input || !out.output) { printHelp(); process.exit(1); }
  return out;
}

function printHelp() {
  console.log(`
Usage: node tools/live-csv/run.js --input INPUT --output OUTPUT.xlsx [options]

Options:
  --input PATH       CSV or XLSX with columns: Company Name, Phone Number, Website, Email, Area
  --output PATH      Output XLSX path
  --limit N          Process only first N rows (after filter)
  --filter STRING    Only include rows whose Area contains STRING (e.g. "Houston")
  --base-url URL     Public base URL for PDF links (default: BASE_URL env or thrive-report-app.onrender.com)
  --no-pdfs          Skip PDF generation (data only, faster)
  --classify-only    Only run industry classification (fast pass for review before full run)
  --overrides PATH   XLSX with columns: Company Name, Suggested Industry (override) — applied after classification
`);
}

function readRows(inputPath) {
  const buf = fs.readFileSync(inputPath);
  let records;
  if (/\.xlsx?$/i.test(inputPath)) {
    const wb = XLSX.read(buf, { type: 'buffer' });
    records = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } else {
    records = parse(buf, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  }
  // Normalize column names to {company, phone, website, email, city}
  const lc = obj => {
    const o = {};
    for (const k of Object.keys(obj)) o[k.toLowerCase().trim()] = obj[k];
    return o;
  };
  return records.map(r => {
    const x = lc(r);
    return {
      company: x['company name'] || x['company'] || x['name'] || '',
      phone: x['phone number'] || x['phone'] || '',
      website: x['website'] || x['url'] || '',
      email: x['email'] || '',
      city: x['area'] || x['city'] || x['location'] || ''
    };
  }).filter(r => r.company && r.city);
}

function loadOverrides(p) {
  if (!p) return {};
  if (!fs.existsSync(p)) {
    console.error(`[run] overrides file not found: ${p}`);
    process.exit(1);
  }
  const buf = fs.readFileSync(p);
  let records;
  if (/\.xlsx?$/i.test(p)) {
    const wb = XLSX.read(buf, { type: 'buffer' });
    records = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } else {
    records = parse(buf, { columns: true, skip_empty_lines: true, trim: true, relax_column_count: true });
  }
  const out = {};
  for (const r of records) {
    const company = (r['Company Name'] || r.company || '').toString().trim().toLowerCase();
    const override = (r['Suggested Industry (override)'] || r.override || '').toString().trim().toLowerCase();
    if (company && override) out[company] = override;
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  console.log(`[run] input=${args.input} output=${args.output} limit=${args.limit ?? 'all'} filter=${args.filter || 'none'} pdfs=${args.generatePdfs} classifyOnly=${args.classifyOnly}`);

  let rows = readRows(args.input);
  console.log(`[run] read ${rows.length} rows`);
  if (args.filter) rows = rows.filter(r => r.city.toLowerCase().includes(args.filter.toLowerCase()));
  if (args.limit) rows = rows.slice(0, args.limit);
  console.log(`[run] processing ${rows.length} rows after filter/limit`);

  const t0 = Date.now();

  if (args.classifyOnly) {
    const reviewRows = await classifyOnly({ rows, log: (...m) => console.log(...m) });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(reviewRows), 'Industry Review');
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    XLSX.writeFile(wb, args.output);
    const counts = reviewRows.reduce((acc, r) => { acc[r.Confidence] = (acc[r.Confidence] || 0) + 1; return acc; }, {});
    console.log(`\n[run] wrote ${args.output}`);
    console.log(`[run] ${reviewRows.length} unique companies classified, confidence counts:`, counts);
    console.log(`[run] elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return;
  }

  const industryOverrides = loadOverrides(args.overridesPath);
  if (Object.keys(industryOverrides).length) {
    console.log(`[run] loaded ${Object.keys(industryOverrides).length} industry overrides from ${args.overridesPath}`);
  }

  const { enriched, groupSummary, pdfsGenerated } = await processRows({
    rows,
    baseUrl: args.baseUrl,
    generatePdfs: args.generatePdfs,
    industryOverrides,
    pdfConcurrency: args.pdfConcurrency || 6,
    log: (...m) => console.log(...m)
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(enriched), 'Companies');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(groupSummary), 'Groups');
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  XLSX.writeFile(wb, args.output);
  console.log(`\n[run] wrote ${args.output}`);
  console.log(`[run] ${enriched.length} rows enriched, ${pdfsGenerated} PDFs generated, ${groupSummary.length} groups, ${elapsed}s elapsed`);
})().catch(err => {
  console.error('[run] FATAL:', err);
  process.exit(1);
});
