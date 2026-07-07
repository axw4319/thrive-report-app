// Adapt the live-engine output (group metrics + per-prompt responses) into the shape
// the existing thrive-report-app pdf-generator.generateReportHTML() expects:
// { target, brands, prompts, models, reportData, modelData, promptData }
//
// reportData rows = { brand: { id, name }, visibility, share_of_voice, mention_count, position, sentiment, visibility_total }

const { normalizeBrand } = require('./brand-extractor');

function brandIdFor(name) {
  return 'live_' + normalizeBrand(name).replace(/\s+/g, '_').slice(0, 60);
}

// Convert group metrics + raw responses into pdf-ready data for ONE target company.
// targetDisplayName: the company name to show in the PDF header (always the input company)
// matchedRow:        the row from groupResult.brands that this company is matched to (or null if unmatched)
// groupResult:       { brands: [...], totals: {...} } from metrics.js
// responses:         [{ promptText, modelName, brands }] from the live AI run
// modelNames:        ['chatgpt','gemini','perplexity','google_ai_overview']
// promptList:        [{ prompt, category }, ...]
function buildReportData({ targetDisplayName, matchedRow, groupResult, responses, modelNames, promptList }) {
  // If matched, the target's metrics come from matchedRow (which IS one of the rows in groupResult.brands).
  // If unmatched, synthesize a zero row and append it to the brand list.
  let targetRow;
  let allBrands = [...groupResult.brands];

  if (matchedRow) {
    targetRow = matchedRow;
  } else {
    targetRow = {
      brand_name: targetDisplayName,
      normalized_name: normalizeBrand(targetDisplayName),
      mention_count: 0,
      avg_position: 0,
      avg_sentiment: 0,
      market_share_pct: 0,
      visibility_pct: 0,
      local_rank: groupResult.brands.length + 1
    };
    allBrands.push(targetRow);
  }

  // PDF target uses the INPUT display name (so the report is titled what the user submitted)
  // but its metrics row is the LLM-extracted matched row.
  const targetId = brandIdFor(targetDisplayName);

  // brand records for the PDF: { id, name }
  // For the matched row, override its name with the input display name so charts label it consistently.
  const brands = allBrands.map(b => {
    if (b === targetRow) return { id: targetId, name: targetDisplayName };
    return { id: brandIdFor(b.brand_name), name: b.brand_name };
  });
  const target = { id: targetId, name: targetDisplayName };

  // reportData rows the PDF expects (visibility/SOV are 0-1 ratios, sentiment 0-100)
  const reportData = allBrands.map(b => ({
    brand: b === targetRow
      ? { id: targetId, name: targetDisplayName }
      : { id: brandIdFor(b.brand_name), name: b.brand_name },
    visibility: b.visibility_pct / 100,
    share_of_voice: b.market_share_pct / 100,
    mention_count: b.mention_count,
    position: b.avg_position || 0,
    // sentiment scale: brand-extractor returns -1..+1, PDF expects 0-100 (most brands 65-85).
    sentiment: Math.round(((b.avg_sentiment + 1) / 2) * 100),
    visibility_total: b.mention_count
  }));

  // models = list of { id, name }
  const models = modelNames.map(n => ({ id: n, name: n }));

  // prompts = list of { id, text, prompt_text, category }
  const prompts = promptList.map((p, i) => ({
    id: 'p_' + (i + 1),
    text: p.prompt,
    prompt_text: p.prompt,
    category: p.category || ''
  }));

  const brandRef = b => b === targetRow
    ? { id: targetId, name: targetDisplayName }
    : { id: brandIdFor(b.brand_name), name: b.brand_name };

  // modelData: per-(brand, model) breakdown — visibility per model
  const modelData = [];
  for (const b of allBrands) {
    for (const m of modelNames) {
      const promptsHit = new Set();
      for (const r of responses) {
        if (r.modelName !== m) continue;
        if (!r.brands) continue;
        if (r.brands.some(x => (x.normalized_name || normalizeBrand(x.brand_name || '')) === b.normalized_name)) {
          promptsHit.add(r.promptText);
        }
      }
      const totalPromptsForModel = new Set(responses.filter(r => r.modelName === m).map(r => r.promptText)).size || 1;
      modelData.push({
        brand: brandRef(b),
        model: { id: m, name: m },
        visibility: promptsHit.size / totalPromptsForModel,
        mention_count: promptsHit.size
      });
    }
  }

  // promptData: per-(brand, prompt) — does this brand show up for this prompt at all?
  const promptData = [];
  for (const b of allBrands) {
    for (const p of prompts) {
      const modelsHit = new Set();
      for (const r of responses) {
        if (r.promptText !== p.prompt_text) continue;
        if (!r.brands) continue;
        if (r.brands.some(x => (x.normalized_name || normalizeBrand(x.brand_name || '')) === b.normalized_name)) {
          modelsHit.add(r.modelName);
        }
      }
      promptData.push({
        brand: brandRef(b),
        prompt: { id: p.id, text: p.prompt_text },
        visibility: modelsHit.size / modelNames.length,
        mention_count: modelsHit.size
      });
    }
  }

  return { target, brands, prompts, models, reportData, modelData, promptData };
}

function buildReportDataWithContext(args) {
  const out = buildReportData(args);
  if (args.industry) out.industry = args.industry;
  if (args.city) out.city = args.city;
  return out;
}

module.exports = { buildReportData, buildReportDataWithContext };
