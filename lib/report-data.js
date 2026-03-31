const db = require('../database');
const { normalizeBrand } = require('./brand-extractor');

// Ensure target brand always appears in top brands list (at end if not in top 10)
function buildTopBrandsWithTarget(metrics, targetNorm, brandName) {
  const top = metrics.slice(0, 10);
  const targetInTop = top.some(m => m.normalized_name === targetNorm);
  if (!targetInTop) {
    const targetMetric = metrics.find(m => m.normalized_name === targetNorm);
    if (targetMetric) {
      top.push(targetMetric);
    } else {
      // Brand wasn't found at all — add with zeros
      top.push({
        brand_name: brandName,
        normalized_name: targetNorm,
        visibility_pct: 0,
        market_share_pct: 0,
        avg_rank: 0,
        mention_count: 0,
        avg_sentiment: 0
      });
    }
  }
  return top;
}

function assembleReport(scanId) {
  const scan = db.getScan.get(scanId);
  if (!scan) return null;

  const metrics = db.getMetrics.all(scanId);
  const mentions = db.getMentions.all(scanId);
  const prompts = db.getPrompts.all(scanId);
  const responses = db.getResponses.all(scanId);
  const targetNorm = normalizeBrand(scan.brand_name);

  // Find target brand metrics
  const targetMetrics = metrics.find(m => m.normalized_name === targetNorm) || {
    visibility_pct: 0, market_share_pct: 0, avg_rank: 0, mention_count: 0, avg_sentiment: 0
  };

  // Models used
  const models = [...new Set(responses.map(r => r.model_name))];

  // Per-model breakdown for all brands
  const modelBreakdown = {};
  for (const model of models) {
    const modelMentions = mentions.filter(m => m.model_name === model);
    const brandCounts = {};
    for (const m of modelMentions) {
      if (!brandCounts[m.normalized_name]) brandCounts[m.normalized_name] = { name: m.brand_name, count: 0 };
      brandCounts[m.normalized_name].count++;
    }
    const sorted = Object.values(brandCounts).sort((a, b) => b.count - a.count);
    const top5 = sorted.slice(0, 5);
    // Ensure target brand always appears in model breakdown
    if (!top5.some(b => normalizeBrand(b.name) === targetNorm)) {
      const targetEntry = brandCounts[targetNorm];
      top5.push(targetEntry || { name: scan.brand_name, count: 0 });
    }
    modelBreakdown[model] = top5;
  }

  // Per-prompt results
  const promptResults = prompts.map(p => {
    const promptResponses = responses.filter(r => r.prompt_text === p.prompt_text);
    const promptMentions = mentions.filter(m => m.prompt_text === p.prompt_text);
    const brandsFound = [...new Set(promptMentions.map(m => m.normalized_name))].length;

    // Target brand visibility for this prompt: % of model responses that mentioned it
    const targetMentions = promptMentions.filter(m => m.normalized_name === targetNorm);
    const modelsForPrompt = [...new Set(promptResponses.map(r => r.model_name))];
    const modelsWithTarget = [...new Set(targetMentions.map(m => m.model_name))];
    const promptVisibility = modelsForPrompt.length > 0
      ? Math.round((modelsWithTarget.length / modelsForPrompt.length) * 1000) / 10
      : 0;

    // Top brand for this prompt
    const brandCounts = {};
    for (const m of promptMentions) {
      if (!brandCounts[m.normalized_name]) brandCounts[m.normalized_name] = { name: m.brand_name, count: 0 };
      brandCounts[m.normalized_name].count++;
    }
    const topBrand = Object.values(brandCounts).sort((a, b) => b.count - a.count)[0];

    // Top 3 competitors for this prompt
    const top3 = Object.values(brandCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(b => b.name);

    return {
      prompt: p.prompt_text,
      category: p.category,
      brands_found: brandsFound,
      visibility_pct: promptVisibility,
      top_brand: topBrand ? topBrand.name : '-',
      top_competitors: top3
    };
  });

  // Leader gap
  const leader = metrics[0];
  const leaderGap = leader && leader.normalized_name !== targetNorm
    ? Math.round(leader.visibility_pct - targetMetrics.visibility_pct)
    : 0;

  return {
    scan: {
      id: scan.id,
      brand_name: scan.brand_name,
      website_url: scan.website_url,
      industry: scan.industry,
      location: scan.location,
      created_at: scan.created_at
    },
    target: {
      ...targetMetrics,
      brand_name: scan.brand_name,
      normalized_name: targetNorm
    },
    leader: leader ? { brand_name: leader.brand_name, visibility_pct: leader.visibility_pct } : null,
    leader_gap: leaderGap,
    brands_tracked: metrics.length,
    total_prompts: prompts.length,
    total_conversations: responses.filter(r => r.raw_response).length,
    models,
    metrics: metrics.slice(0, 50),
    model_breakdown: modelBreakdown,
    prompt_results: promptResults,
    top_brands: buildTopBrandsWithTarget(metrics, targetNorm, scan.brand_name)
  };
}

module.exports = { assembleReport };
