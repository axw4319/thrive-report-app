// Orchestrator: takes a list of {company, website, city} rows, groups by (city, industry),
// runs 5 AI prompts × 4 LLMs per group ONCE, then derives per-company visibility/market-share/local-rank.

const path = require('path');
const fs = require('fs');
const { classify } = require('./industry-classifier');
const { generateLocalPrompts } = require('./prompt-generator');
const { queryAll, getModelNames } = require('./ai-clients');
const { extractBrandsBatch, normalizeBrand } = require('./brand-extractor');
const { computeGroupMetrics } = require('./metrics');
const { buildReportDataWithContext } = require('./pdf-adapter');
const { generatePDF, closeBrowser } = require('../pdf-generator');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const slug = s => String(s || '').replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '_').toLowerCase();
const pdfFilename = company => 'AI_Visibility_Analysis_-_' + slug(company) + '.pdf';

async function classifyAll(rows, log = console.log) {
  const cache = new Map(); // company-name -> {label, source, confidence}
  const out = [];
  for (const r of rows) {
    const key = (r.company || '').trim().toLowerCase();
    if (!key) continue;
    let cls = cache.get(key);
    if (!cls) {
      cls = await classify(r.company, r.website);
      cache.set(key, cls);
      const tag = cls.confidence === 'review' ? '⚠ REVIEW' : cls.confidence;
      log(`  [classify] ${tag.padEnd(8)} ${r.company} -> ${cls.label} (${cls.source})`);
    }
    out.push({ ...r, industry: cls.label, industry_source: cls.source, industry_confidence: cls.confidence });
  }
  return out;
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

async function runGroup({ city, industry, companies }, log = console.log) {
  log(`\n=== ${industry.toUpperCase()} in ${city.toUpperCase()} (${companies.length} companies) ===`);

  // 1. Generate 5 city-localized prompts
  const prompts = await generateLocalPrompts(industry, city);
  log(`  [prompts] generated ${prompts.length}:`);
  prompts.forEach((p, i) => log(`    ${i + 1}. [${p.category}] ${p.prompt}`));

  // 2. Run all 5 prompts × 4 LLMs in parallel
  log(`  [llm] querying ${prompts.length} prompts × ${getModelNames().length} models in parallel...`);
  const tStart = Date.now();
  const promptResults = await Promise.all(
    prompts.map(async (p) => {
      const responses = await queryAll(p.prompt);
      return { prompt: p, responses };
    })
  );
  log(`  [llm] done in ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  // 3. Batch-extract brands per (prompt, model) — one OpenAI call per prompt covering all models
  log(`  [extract] extracting brands from responses...`);
  const flatResponses = []; // { promptText, modelName, brands }
  for (const pr of promptResults) {
    const validResponses = pr.responses.filter(r => r.response);
    if (!validResponses.length) continue;
    const brandsByModel = await extractBrandsBatch(validResponses, pr.prompt.prompt);
    for (const r of validResponses) {
      flatResponses.push({
        promptText: pr.prompt.prompt,
        modelName: r.model_name,
        brands: brandsByModel[r.model_name] || []
      });
    }
  }
  log(`  [extract] ${flatResponses.length} (prompt × model) responses parsed`);

  // 4. Compute group metrics
  const modelNames = getModelNames();
  const groupResult = computeGroupMetrics(flatResponses, modelNames);
  log(`  [metrics] ${groupResult.brands.length} unique brands extracted, ${groupResult.totals.totalMentions} total mentions`);
  log(`  [metrics] top 15 by visibility:`);
  groupResult.brands.slice(0, 15).forEach((b, i) => {
    log(`    ${i + 1}. ${b.brand_name.padEnd(45)} vis=${String(b.visibility_pct).padStart(5)}%  share=${String(b.market_share_pct).padStart(5)}%  mentions=${b.mention_count}`);
  });

  return { city, industry, prompts, flatResponses, groupResult, modelNames };
}

// Domain-aware token stripping: drop industry/service words and city words so we match
// "Blue Hippo Restoration" -> ["blue", "hippo"] which will line up with LLM-extracted "Blue Hippo".
const NOISE_TOKENS = new Set([
  // suffixes
  'inc', 'llc', 'ltd', 'co', 'company', 'companies', 'corp', 'group', 'agency', 'services', 'service',
  'pros', 'experts', 'specialist', 'specialists', 'team', 'solutions',
  // industry words (cover the labels in industry-classifier RULES)
  'restoration', 'restorations', 'restore', 'restores', 'remediation', 'cleanup',
  'plumbing', 'plumber', 'plumbers',
  'roofing', 'roofer', 'roofers',
  'hvac', 'heating', 'cooling', 'air',
  'concrete', 'epoxy', 'foundation', 'flooring', 'floor', 'floors', 'sealant', 'sealants', 'waterproofing',
  'pest', 'control', 'maids', 'cleaning',
  'construction', 'contractor', 'contracting', 'remodel', 'remodeling', 'renovation', 'builder',
  'water', 'damage', 'fire', 'mold', 'flood',
  'emergency', 'commercial', 'residential',
  // generic
  'the', 'of', 'and', 'in', 'at', 'for', 'a', 'an'
]);
const CITY_TOKENS = new Set(['houston', 'dallas', 'austin', 'san', 'antonio', 'tx', 'texas', 'north', 'south', 'east', 'west', 'central', 'far', 'near', 'metro']);

function tokenizeBrand(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !NOISE_TOKENS.has(t) && !CITY_TOKENS.has(t));
}

function findCompanyMetrics(groupResult, companyName) {
  const norm = normalizeBrand(companyName);

  // 1. Exact normalized match
  let row = groupResult.brands.find(b => b.normalized_name === norm);
  if (row) return { row, matched: 'exact' };

  // 2. Token-overlap fuzzy match using domain-aware noise filtering
  const targetTokens = tokenizeBrand(companyName);
  if (targetTokens.length === 0) {
    return notMatched(groupResult, companyName, norm);
  }

  let best = null;
  for (const b of groupResult.brands) {
    const candidateTokens = tokenizeBrand(b.brand_name);
    if (candidateTokens.length === 0) continue;
    const setT = new Set(targetTokens);
    const setC = new Set(candidateTokens);
    const intersection = [...setT].filter(t => setC.has(t)).length;
    const denom = Math.min(setT.size, setC.size);
    const score = denom === 0 ? 0 : intersection / denom;
    // Require at least one shared token AND coverage of the smaller set ≥ 0.5
    if (intersection >= 1 && score >= 0.5) {
      if (!best || score > best.score) best = { row: b, score };
    }
  }
  if (best) return { row: best.row, matched: 'fuzzy', score: best.score };

  // 3. Plain substring fallback (last resort) — but reject short matches that are likely false positives
  const lower = norm.toLowerCase();
  if (lower.length >= 5) {
    row = groupResult.brands.find(b => {
      const bn = b.normalized_name.toLowerCase();
      return (bn.length >= 5 && (bn.includes(lower) || lower.includes(bn)));
    });
    if (row) return { row, matched: 'substring' };
  }

  return notMatched(groupResult, companyName, norm);
}

function notMatched(groupResult, companyName, norm) {
  return {
    row: {
      brand_name: companyName,
      normalized_name: norm,
      visibility_pct: 0,
      market_share_pct: 0,
      mention_count: 0,
      avg_position: 0,
      avg_sentiment: 0,
      local_rank: null  // null = not surfaced
    },
    matched: false
  };
}

async function classifyOnly({ rows, log = console.log }) {
  log(`\n[classify-only] Classifying ${rows.length} rows...`);
  const classified = await classifyAll(rows, log);
  // De-dupe to one row per unique company for the review sheet
  const seen = new Map();
  for (const r of classified) {
    const key = (r.company || '').trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()].map(r => ({
    'Company Name': r.company,
    'Website': r.website,
    'Area': r.city,
    'Industry (auto)': r.industry,
    'Source': r.industry_source,
    'Confidence': r.industry_confidence,
    'Suggested Industry (override)': '' // blank column for Aaron to fill in
  }));
}

async function processRows({ rows, baseUrl, generatePdfs = true, industryOverrides = {}, pdfConcurrency = 6, log = console.log }) {
  // 1. Classify (skipped per-row when override exists)
  const overrideKeys = new Set(Object.keys(industryOverrides || {}));
  log(`\n[1/4] Classifying ${rows.length} rows (overrides=${overrideKeys.size})...`);
  const classified = [];
  let overrideHits = 0, classifiedCount = 0;
  for (const r of rows) {
    const k = (r.company || '').trim().toLowerCase();
    if (overrideKeys.has(k)) {
      classified.push({ ...r, industry: industryOverrides[k], industry_source: 'override', industry_confidence: 'high' });
      overrideHits++;
    } else {
      const cls = await classify(r.company, r.website);
      classified.push({ ...r, industry: cls.label, industry_source: cls.source, industry_confidence: cls.confidence });
      classifiedCount++;
      const tag = cls.confidence === 'high' ? 'HIGH' : cls.confidence === 'medium' ? 'medium' : 'low';
      log(`  [classify] ${tag.padEnd(8)} ${r.company} -> ${cls.label} (${cls.source})`);
    }
  }
  log(`  [overrides] ${overrideHits} applied, ${classifiedCount} live-classified`);

  // 2. Group by (city, industry) — but we run on UNIQUE companies per group; rows can repeat
  log(`\n[2/4] Grouping by (city, industry)...`);
  const uniqueCompanies = new Map(); // key: city|industry|companyLower -> first seen row
  for (const r of classified) {
    const k = `${r.city}|||${r.industry}|||${r.company.trim().toLowerCase()}`;
    if (!uniqueCompanies.has(k)) uniqueCompanies.set(k, r);
  }
  const uniqueRows = [...uniqueCompanies.values()];
  const groups = groupBy(uniqueRows, r => `${r.city}|||${r.industry}`);
  log(`  ${uniqueRows.length} unique companies in ${groups.size} (city, industry) groups`);

  // 3. Run each group's prompts
  log(`\n[3/4] Running AI prompts per group...`);
  const groupResults = new Map(); // city|industry -> result
  for (const [key, companies] of groups.entries()) {
    const [city, industry] = key.split('|||');
    const result = await runGroup({ city, industry, companies }, log);
    groupResults.set(key, result);
  }

  // 4. Build per-row enriched output + per-unique-company PDFs (PDFs run in a concurrency pool)
  log(`\n[4/4] Building per-row output${generatePdfs ? ' + generating PDFs (concurrency=' + pdfConcurrency + ')' : ''}...`);
  const enriched = [];
  const pdfQueue = new Map(); // filename -> { pdfData, rankStr, company }

  for (const original of classified) {
    const key = `${original.city}|||${original.industry}`;
    const gr = groupResults.get(key);
    const { row: metrics, matched, score } = findCompanyMetrics(gr.groupResult, original.company);

    const filename = pdfFilename(original.company);
    const reportLink = `${baseUrl}/reports/${encodeURIComponent(filename)}`;

    // Queue one PDF per unique filename
    if (generatePdfs && !pdfQueue.has(filename)) {
      const pdfData = buildReportDataWithContext({
        targetDisplayName: original.company,
        matchedRow: matched ? metrics : null,
        groupResult: gr.groupResult,
        responses: gr.flatResponses,
        modelNames: gr.modelNames,
        promptList: gr.prompts,
        industry: gr.industry,
        city: gr.city
      });
      const rankStr = metrics.local_rank ? `rank ${metrics.local_rank}/${gr.groupResult.brands.length}` : 'not surfaced';
      pdfQueue.set(filename, { pdfData, rankStr, company: original.company });
    }

    const rankDisplay = metrics.local_rank
      ? String(metrics.local_rank)
      : 'Not surfaced';

    enriched.push({
      'Company Name': original.company,
      'Phone Number': original.phone || '',
      'Website': original.website || '',
      'Email': original.email || '',
      'Area': original.city,
      'Industry (auto)': original.industry,
      'Industry Confidence': original.industry_confidence || '',
      'AI Visibility': metrics.visibility_pct + '%',
      'Market Share': metrics.market_share_pct + '%',
      'AI Rank': rankDisplay,
      'Mentions': metrics.mention_count,
      'PDF Report': reportLink,
      'Match': matched === 'exact' ? 'exact'
        : matched === 'fuzzy' ? `fuzzy (${score ? score.toFixed(2) : ''})`
        : matched === 'substring' ? 'substring'
        : 'not mentioned'
    });
  }

  const pdfsGenerated = new Set();
  if (generatePdfs && pdfQueue.size > 0) {
    const entries = [...pdfQueue.entries()]; // [filename, {pdfData,rankStr,company}]
    const total = entries.length;
    let next = 0;
    let done = 0;
    let errors = 0;

    async function worker(id) {
      while (true) {
        const idx = next++;
        if (idx >= entries.length) return;
        const [filename, { pdfData, rankStr, company }] = entries[idx];
        try {
          await generatePDF(pdfData, filename);
          pdfsGenerated.add(filename);
          done++;
          if (done % 25 === 0 || done === total) {
            log(`  [pdf] ${done}/${total} (${Math.round(done/total*100)}%) — latest: ${filename.replace('AI_Visibility_Analysis_-_','').slice(0,40)} (${rankStr})`);
          }
        } catch (e) {
          errors++;
          log(`  [pdf] ERROR for ${company}: ${e.message}`);
        }
      }
    }

    log(`  [pdf] queueing ${total} unique PDFs across ${pdfConcurrency} workers...`);
    await Promise.all(Array.from({ length: pdfConcurrency }, (_, i) => worker(i)));
    log(`  [pdf] done: ${pdfsGenerated.size} generated, ${errors} errors`);
    await closeBrowser();
  }

  // Group-level summary (the prompts + LLM outputs we ran)
  const groupSummary = [];
  for (const [key, gr] of groupResults.entries()) {
    groupSummary.push({
      'City': gr.city,
      'Industry': gr.industry,
      'Companies in group': groups.get(key).length,
      'Brands surfaced by LLMs': gr.groupResult.brands.length,
      'Total mentions': gr.groupResult.totals.totalMentions,
      'Prompts': gr.prompts.map((p, i) => `${i + 1}. ${p.prompt}`).join(' | ')
    });
  }

  return { enriched, groupSummary, pdfsGenerated: pdfsGenerated.size };
}

module.exports = { processRows, classifyOnly, pdfFilename };
