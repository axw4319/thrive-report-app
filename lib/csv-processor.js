// CSV Bulk Processing Orchestrator
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { PeecAPI, getDates } = require('./peec-api');
const { matchBrand } = require('./fuzzy');
const { runLLMFallback } = require('./llm-fallback');
const { generatePDF, closeBrowser } = require('./pdf-generator');

// Default values for untracked/unmatched brands
const DEFAULTS = {
  visibility: 0.012,    // 1.2%
  mentions: 2,
  sentiment: 53,
  market_share: 0.004,  // 0.4%
  reputation: 53
};

/**
 * Build a synthetic report data array from the brand list when the API returns no report data.
 * Uses defaults for all brands so PDFs still render a full competitor table.
 */
function buildSyntheticReport(brands) {
  return brands.map(b => ({
    brand: { id: b.id, name: b.name },
    visibility: DEFAULTS.visibility,
    share_of_voice: DEFAULTS.market_share,
    mention_count: DEFAULTS.mentions,
    position: 0,
    sentiment: DEFAULTS.sentiment,
    visibility_total: 0
  }));
}

/**
 * Format top 3 competitors as a string: "A at X%, B at Y%, and C at Z%"
 */
function formatCompetitors(reportData, excludeBrandId) {
  const sorted = [...reportData]
    .filter(r => r.brand?.id !== excludeBrandId)
    .sort((a, b) => (b.visibility || 0) - (a.visibility || 0))
    .slice(0, 3);

  if (!sorted.length) return '';
  const parts = sorted.map(r => `${r.brand?.name || '?'} at ${((r.visibility || 0) * 100).toFixed(1)}%`);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * Process a CSV file with bulk brand matching and report generation
 */
async function processCSV(csvBuffer, apiKey, projectIds, baseUrl, onProgress = () => {}) {
  const api = new PeecAPI(apiKey);

  // 1. Parse CSV
  onProgress('Parsing CSV...');
  const records = parse(csvBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true
  });
  onProgress(`Parsed ${records.length} rows`);

  // 2. Filter to Open/Closed=TRUE
  const openRows = records.filter(r => {
    const val = (r['Open/Closed'] || '').toString().trim().toUpperCase();
    return val === 'TRUE';
  });
  onProgress(`Filtered to ${openRows.length} open rows (from ${records.length} total)`);

  // 3. Fetch brands from all selected projects
  onProgress('Fetching brands from selected projects...');
  const projectBrands = {};
  const projectData = {};

  for (const pid of projectIds) {
    try {
      const brands = await api.getBrands(pid);
      projectBrands[pid] = brands;
      onProgress(`  Project ${pid}: ${brands.length} brands`);
    } catch (e) {
      onProgress(`  Project ${pid}: ERROR - ${e.message}`);
      projectBrands[pid] = [];
    }
  }

  // 4. Fetch report data for each project
  onProgress('Fetching report data for each project...');
  for (const pid of projectIds) {
    try {
      const prompts = await api.getPrompts(pid);
      const models = await api.getModels(pid);

      let dateBody = getDates(7);
      let reportData = await api.getBrandReport(pid, dateBody);
      if (!reportData.length) {
        dateBody = {};
        reportData = await api.getBrandReport(pid, dateBody);
      }

      // If API returns no report data, build synthetic data from brand list
      const hasRealData = reportData.length > 0;
      if (!hasRealData) {
        onProgress(`  Project ${pid}: No report data from API — using brand list with defaults`);
        reportData = buildSyntheticReport(projectBrands[pid] || []);
      }

      let modelData = [];
      try { modelData = await api.getBrandReportByModel(pid, dateBody); } catch (e) { }
      let promptData = [];
      try { promptData = await api.getBrandReportByPrompt(pid, dateBody); } catch (e) { }

      projectData[pid] = {
        brands: projectBrands[pid] || [],
        prompts, models, reportData, modelData, promptData, dateBody,
        hasRealData
      };
      onProgress(`  Project ${pid}: ${reportData.length} entries (${hasRealData ? 'live' : 'synthetic'}), ${prompts.length} prompts, ${models.length} models`);
    } catch (e) {
      onProgress(`  Project ${pid} report: ERROR - ${e.message}`);
      projectData[pid] = {
        brands: projectBrands[pid] || [],
        prompts: [], models: [],
        reportData: buildSyntheticReport(projectBrands[pid] || []),
        modelData: [], promptData: [], dateBody: {},
        hasRealData: false
      };
    }
  }

  // 5. Match CSV companies to Peec brands
  onProgress('Matching companies to Peec brands...');
  const companyMatches = new Map();
  const unmatchedCompanies = [];

  const uniqueCompanies = [...new Set(openRows.map(r => r.current_company).filter(Boolean))];
  onProgress(`${uniqueCompanies.length} unique companies to match`);

  for (const company of uniqueCompanies) {
    let bestMatch = null;
    for (const pid of projectIds) {
      const brands = projectBrands[pid] || [];
      const match = matchBrand(company, brands);
      if (match && (!bestMatch || match.score > bestMatch.score)) {
        bestMatch = { ...match, projectId: pid };
      }
    }
    if (bestMatch) {
      companyMatches.set(company, bestMatch);
    } else {
      unmatchedCompanies.push(company);
    }
  }

  const matched = uniqueCompanies.length - unmatchedCompanies.length;
  onProgress(`Matched: ${matched}/${uniqueCompanies.length} companies (${unmatchedCompanies.length} unmatched)`);

  // 6. LLM Fallback for unmatched companies
  const llmResults = new Map();
  if (unmatchedCompanies.length > 0) {
    onProgress(`Running LLM fallback for ${unmatchedCompanies.length} unmatched companies...`);
    for (const pid of projectIds) {
      const pd = projectData[pid];
      if (!pd || !pd.prompts.length) continue;
      const results = await runLLMFallback(pid, pd.prompts, unmatchedCompanies, onProgress);
      for (const [key, val] of results) {
        if (!llmResults.has(key)) llmResults.set(key, val);
      }
    }
    onProgress(`LLM fallback found ${llmResults.size} additional matches`);
  }

  // 7. Build enriched data and generate PDFs for ALL companies
  onProgress('Generating reports and enriched CSV...');
  const enrichedRows = [];
  const pdfGenerated = new Set();

  // Pick the "best" project for unmatched companies (the one with the most brands)
  // Use the first project as default for unmatched companies
  const defaultProjectId = projectIds[0];

  let processedCount = 0;
  for (const row of openRows) {
    processedCount++;
    if (processedCount % 50 === 0) {
      onProgress(`Processing row ${processedCount}/${openRows.length}...`);
    }

    const company = row.current_company || '';
    if (!company) continue;

    const match = companyMatches.get(company);
    const llmMatch = llmResults.get(company.toLowerCase().trim());
    const safeName = company.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').toLowerCase();

    let visibility = DEFAULTS.visibility;
    let mentions = DEFAULTS.mentions;
    let sentiment = DEFAULTS.sentiment;
    let marketShare = DEFAULTS.market_share;
    let reputation = DEFAULTS.reputation;
    let competitors = '';
    let reportLink = '';

    // Determine which project to use for this company
    let pid, pd, targetBrand;

    if (match) {
      pid = match.projectId;
      pd = projectData[pid];
      targetBrand = match.brand;

      // Pull real data if available
      const brandReport = pd.reportData.find(r => r.brand?.id === match.brand.id);
      if (brandReport) {
        visibility = brandReport.visibility || DEFAULTS.visibility;
        mentions = brandReport.mention_count || DEFAULTS.mentions;
        sentiment = brandReport.sentiment || DEFAULTS.sentiment;
        marketShare = brandReport.share_of_voice || DEFAULTS.market_share;
        reputation = brandReport.sentiment || DEFAULTS.reputation;
      }

      // Competitors from same project
      competitors = formatCompetitors(pd.reportData, match.brand.id);
    } else {
      // Unmatched company — use default project, create a virtual brand
      pid = defaultProjectId;
      pd = projectData[pid];
      targetBrand = { id: '__unmatched__' + safeName, name: company };

      // Competitors from the default project (top 3 overall)
      competitors = formatCompetitors(pd.reportData, null);
    }

    // Generate PDF for EVERY company
    if (!pdfGenerated.has(safeName)) {
      try {
        await generatePDF({
          target: targetBrand,
          brands: pd.brands,
          prompts: pd.prompts,
          models: pd.models,
          reportData: pd.reportData,
          modelData: pd.modelData,
          promptData: pd.promptData
        }, safeName);
        pdfGenerated.add(safeName);
      } catch (e) {
        onProgress(`  PDF error for ${company}: ${e.message}`);
      }
    }
    reportLink = `${baseUrl}/reports/${safeName}.pdf`;

    enrichedRows.push({
      first_name: row.first_name || '',
      last_name: row.last_name || '',
      current_company: company,
      current_company_position: row.current_company_position || '',
      profile_url: row.profile_url || '',
      'Open/Closed': row['Open/Closed'] || '',
      Visibility: `${(visibility * 100).toFixed(1)}%`,
      Competitors: competitors,
      'Report Link': reportLink,
      Mentions: mentions,
      'Market Share': `${(marketShare * 100).toFixed(1)}%`,
      Sentiment: sentiment,
      Reputation: reputation
    });
  }

  // Close puppeteer browser
  await closeBrowser();

  // 8. Convert to CSV string
  const headers = ['first_name', 'last_name', 'current_company', 'current_company_position', 'profile_url', 'Open/Closed', 'Visibility', 'Competitors', 'Report Link', 'Mentions', 'Market Share', 'Sentiment', 'Reputation'];
  const csvLines = [headers.join(',')];
  for (const row of enrichedRows) {
    const line = headers.map(h => {
      const val = String(row[h] || '');
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    }).join(',');
    csvLines.push(line);
  }

  const stats = {
    totalRows: records.length,
    openRows: openRows.length,
    uniqueCompanies: uniqueCompanies.length,
    matched,
    llmMatched: llmResults.size,
    unmatched: unmatchedCompanies.length - llmResults.size,
    pdfsGenerated: pdfGenerated.size
  };

  onProgress(`Done! ${stats.matched} matched, ${stats.llmMatched} LLM fallback, ${stats.unmatched} unmatched, ${stats.pdfsGenerated} PDFs generated`);

  return { enrichedCsv: csvLines.join('\n'), stats };
}

module.exports = { processCSV, DEFAULTS };
