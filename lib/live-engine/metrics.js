// Compute per-brand visibility / market share / local rank from a set of prompt-model responses.
// Inputs:
//   responses: [{ promptText, modelName, brands: [{ brand_name, normalized_name, position, sentiment_score, context_snippet }] }]
// One entry per (prompt × model). Brands are already extracted.

const { normalizeBrand } = require('./brand-extractor');

function computeGroupMetrics(responses, modelNames) {
  const totalPrompts = new Set(responses.map(r => r.promptText)).size;
  const totalCombinations = totalPrompts * modelNames.length; // denominator for visibility%

  const brandMap = new Map(); // normalized_name -> aggregate
  let totalMentions = 0;

  for (const r of responses) {
    if (!r.brands || !r.brands.length) continue;
    const seenInThisResponse = new Set();
    for (const b of r.brands) {
      const key = b.normalized_name || normalizeBrand(b.brand_name || '');
      if (!key) continue;
      if (!brandMap.has(key)) {
        brandMap.set(key, {
          brand_name: b.brand_name,
          normalized_name: key,
          mention_count: 0,
          positions: [],
          sentiments: [],
          promptsAppearedIn: new Set(),
          modelsAppearedIn: new Set(),
          contexts: []
        });
      }
      const agg = brandMap.get(key);
      // Prefer the longer / better-cased display name
      if ((b.brand_name || '').length > agg.brand_name.length) agg.brand_name = b.brand_name;
      agg.mention_count++;
      totalMentions++;
      if (b.position) agg.positions.push(b.position);
      if (typeof b.sentiment_score === 'number') agg.sentiments.push(b.sentiment_score);
      agg.promptsAppearedIn.add(r.promptText);
      agg.modelsAppearedIn.add(r.modelName);
      if (b.context_snippet) agg.contexts.push(b.context_snippet);
      seenInThisResponse.add(key);
    }
  }

  const out = [];
  for (const [key, agg] of brandMap.entries()) {
    const promptsAppeared = agg.promptsAppearedIn.size;
    const modelsAppeared = agg.modelsAppearedIn.size;
    // Visibility = (prompt × model) combinations the brand showed up in / total combinations
    // We approximate by: unique prompt-appearances × unique model-appearances ≤ totalCombinations.
    // Cleaner: count distinct (prompt, model) pairs the brand appeared in.
    // We'll redo this with explicit pair-counting below.
    out.push({
      brand_name: agg.brand_name,
      normalized_name: key,
      mention_count: agg.mention_count,
      avg_position: agg.positions.length ? round1(avg(agg.positions)) : 0,
      avg_sentiment: agg.sentiments.length ? round2(avg(agg.sentiments)) : 0,
      prompts_appeared_in: promptsAppeared,
      models_appeared_in: modelsAppeared,
      market_share_pct: totalMentions ? round1((agg.mention_count / totalMentions) * 100) : 0,
      // visibility recomputed below from explicit pair set:
      visibility_pct: 0,
    });
  }

  // Recompute visibility with distinct (prompt, model) pairs.
  const pairsByBrand = new Map(); // normalized -> Set("promptText|||modelName")
  for (const r of responses) {
    if (!r.brands) continue;
    const seen = new Set();
    for (const b of r.brands) {
      const key = b.normalized_name || normalizeBrand(b.brand_name || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (!pairsByBrand.has(key)) pairsByBrand.set(key, new Set());
      pairsByBrand.get(key).add(`${r.promptText}|||${r.modelName}`);
    }
  }
  for (const row of out) {
    const pairs = pairsByBrand.get(row.normalized_name);
    const denom = totalCombinations || 1;
    row.visibility_pct = pairs ? round1((pairs.size / denom) * 100) : 0;
  }

  // Sort by visibility desc; assign rank
  out.sort((a, b) => b.visibility_pct - a.visibility_pct || b.market_share_pct - a.market_share_pct);
  out.forEach((row, i) => { row.local_rank = i + 1; });

  return {
    brands: out,
    totals: { totalMentions, totalPrompts, totalModels: modelNames.length, totalCombinations }
  };
}

function avg(xs) { return xs.reduce((s, x) => s + x, 0) / xs.length; }
function round1(x) { return Math.round(x * 10) / 10; }
function round2(x) { return Math.round(x * 100) / 100; }

module.exports = { computeGroupMetrics };
