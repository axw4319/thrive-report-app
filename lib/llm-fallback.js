// LLM fallback: query prompts across ChatGPT, Gemini, Perplexity, SerpAPI
// Then scan responses for unmatched company names
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function getCachePath(projectId) {
  return path.join(CACHE_DIR, `llm-cache-${projectId}.json`);
}

function loadCache(projectId) {
  const p = getCachePath(projectId);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() - data.timestamp < CACHE_TTL) return data.responses;
    fs.unlinkSync(p); // expired
  } catch { }
  return null;
}

function saveCache(projectId, responses) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(getCachePath(projectId), JSON.stringify({ timestamp: Date.now(), responses }));
}

// Query OpenAI ChatGPT
async function queryOpenAI(prompt, apiKey) {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.3
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.error(`OpenAI error: ${e.message}`);
    return '';
  }
}

// Query Google Gemini
async function queryGemini(prompt, apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.3 }
      })
    });
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (e) {
    console.error(`Gemini error: ${e.message}`);
    return '';
  }
}

// Query Perplexity
async function queryPerplexity(prompt, apiKey) {
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.3
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (e) {
    console.error(`Perplexity error: ${e.message}`);
    return '';
  }
}

// Query SerpAPI (Google search, scan snippets for brand mentions)
async function querySerpAPI(prompt, apiKey) {
  try {
    const qs = new URLSearchParams({ q: prompt, api_key: apiKey, engine: 'google', num: 10 });
    const res = await fetch(`https://serpapi.com/search.json?${qs}`);
    const data = await res.json();
    const snippets = (data.organic_results || []).map(r => `${r.title} ${r.snippet}`).join(' ');
    return snippets;
  } catch (e) {
    console.error(`SerpAPI error: ${e.message}`);
    return '';
  }
}

/**
 * Run LLM fallback for a project's prompts.
 * Returns a Map of companyName (lowercase) -> { found: true, llmSource: 'ChatGPT|Gemini|...' }
 *
 * @param {string} projectId
 * @param {Array} prompts - array of prompt objects from Peec API
 * @param {Array} unmatchedCompanies - array of company name strings to look for
 * @param {Function} onProgress - optional callback(message)
 */
async function runLLMFallback(projectId, prompts, unmatchedCompanies, onProgress = () => {}) {
  const results = new Map();
  if (!unmatchedCompanies.length || !prompts.length) return results;

  // Check cache first
  const cached = loadCache(projectId);
  if (cached) {
    onProgress(`Using cached LLM responses for project ${projectId}`);
    scanResponses(cached, unmatchedCompanies, results);
    return results;
  }

  const keys = {
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    serpapi: process.env.SERPAPI_KEY,
    perplexity: process.env.PERPLEXITY_API_KEY
  };

  const allResponses = [];
  const promptTexts = prompts.map(p => p.messages?.[0]?.content || p.text || '').filter(Boolean);

  onProgress(`Querying ${promptTexts.length} prompts across 4 LLMs...`);

  for (let i = 0; i < promptTexts.length; i++) {
    const prompt = promptTexts[i];
    onProgress(`Prompt ${i + 1}/${promptTexts.length}: "${prompt.substring(0, 60)}..."`);

    // Run all 4 LLMs in parallel for each prompt
    const [oai, gem, ppl, serp] = await Promise.all([
      keys.openai ? queryOpenAI(prompt, keys.openai) : Promise.resolve(''),
      keys.gemini ? queryGemini(prompt, keys.gemini) : Promise.resolve(''),
      keys.perplexity ? queryPerplexity(prompt, keys.perplexity) : Promise.resolve(''),
      keys.serpapi ? querySerpAPI(prompt, keys.serpapi) : Promise.resolve('')
    ]);

    allResponses.push(
      { source: 'ChatGPT', text: oai },
      { source: 'Gemini', text: gem },
      { source: 'Perplexity', text: ppl },
      { source: 'SerpAPI', text: serp }
    );

    // Small delay to avoid rate limits
    if (i < promptTexts.length - 1) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Cache responses
  saveCache(projectId, allResponses);
  onProgress(`Cached ${allResponses.length} LLM responses`);

  // Scan all responses for unmatched companies
  scanResponses(allResponses, unmatchedCompanies, results);
  return results;
}

function scanResponses(responses, companies, results) {
  const lowerResponses = responses.map(r => ({
    source: r.source,
    text: (r.text || '').toLowerCase()
  }));

  for (const company of companies) {
    const lower = company.toLowerCase().trim();
    if (!lower || results.has(lower)) continue;

    for (const resp of lowerResponses) {
      if (resp.text.includes(lower)) {
        results.set(lower, { found: true, llmSource: resp.source });
        break;
      }
    }
  }
}

module.exports = { runLLMFallback };
