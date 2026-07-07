// Classify a company into a localized industry niche from name + (optional) website.
// Keyword-first; falls back to GPT-mini summarisation of the homepage when ambiguous.

const fetch = require('node-fetch');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Order matters: more specific patterns come first.
const RULES = [
  // restoration niches
  { match: /water damage|flood|water restoration|water mitigation/i, label: 'water damage restoration' },
  { match: /fire damage|smoke damage|fire restoration/i,            label: 'fire damage restoration' },
  { match: /mold remediation|mold removal/i,                        label: 'mold remediation' },
  { match: /\brestoration\b|\brestore\b|restore pros|disaster (cleanup|clean ?up)|remediation|reconstruction/i, label: 'water damage restoration' },

  // chimney + fire protection
  { match: /chimney/i,                                              label: 'chimney services' },
  { match: /fire protection|fire sprinkler|fire suppression/i,      label: 'fire protection services' },

  // roofing
  { match: /\broof(ing|er|s)?\b/i,                                  label: 'roofing' },

  // plumbing niches (specific before generic)
  { match: /water heater|tankless/i,                                label: 'water heater installation' },
  { match: /repipe|replumb/i,                                       label: 'plumbing' },
  { match: /hydro ?jet|drain (cleaning|care)|sewer (and )?drain|backflow/i, label: 'plumbing' },
  { match: /\bplumb(ing|er|ers)\b/i,                                label: 'plumbing' },

  // HVAC niches
  { match: /air duct|duct cleaning/i,                               label: 'air duct cleaning' },
  { match: /\bhvac\b|heating.+(cooling|air)|air condition|\b(a\/c|ac repair|ac service)\b|cooling and heating/i, label: 'hvac' },
  { match: /\bair\b/i,                                              label: 'hvac' },

  // foundation + concrete
  { match: /foundation (repair|solutions|level|service)|piers?\b|slab repair/i, label: 'foundation repair' },
  { match: /waterproof(ing)?|sealant|caulk/i,                       label: 'waterproofing' },
  { match: /\bconcrete\b|polished concrete|epoxy floor|garage floor|concrete coating|epoxy coating|readymix/i, label: 'concrete coating' },
  { match: /\bmasonry\b/i,                                          label: 'masonry services' },

  // exterior / earthwork
  { match: /excavat|earthwork|grading|sitework|land (clearing|solutions)/i, label: 'excavation' },
  { match: /paving|asphalt|striping|sealcoat|paver/i,               label: 'paving' },
  { match: /demolition/i,                                            label: 'demolition services' },

  // pest control / wildlife
  { match: /pest control|exterminat|pest service|pest (and|&) lawn|pestmaster|pestsupply|epestcontrol|pest solution/i, label: 'pest control' },
  { match: /bed bug|termite|mosquito|\bbee\b|rodent|wildlife|animal removal|bat removal|trapping/i, label: 'pest control' },
  { match: /weed control|vegetation management/i,                   label: 'pest control' },

  // cleaning niches
  { match: /\bmaids?\b|cleaning service|janitor|house cleaning|carpet clean|steam clean/i, label: 'house cleaning' },

  // electrical / handyman
  { match: /electric(al|ian)/i,                                     label: 'electrical' },
  { match: /handyman|home maintenance|home repair/i,                label: 'handyman services' },

  // construction / landscape
  { match: /\bdrywall\b|sheetrock/i,                                label: 'drywall' },
  { match: /\b(construction|builder|remodel|renovation|contractor|contracting|home services|reconstruction)\b/i, label: 'general contractor' },
  { match: /\bflooring\b|hardwood floor|floor inspection|carpet|tile install|epoxy/i, label: 'flooring' },
  { match: /landscap|lawn care|yard service|lawn (service|maintenance)/i, label: 'landscaping' },
  { match: /\bgarage\b/i,                                           label: 'garage services' },

  // services that often pair with restoration
  { match: /public adjuster/i,                                      label: 'public adjuster' },
  { match: /property solutions|property restoration/i,              label: 'water damage restoration' },
];

function classifyByName(companyName) {
  for (const r of RULES) {
    if (r.match.test(companyName)) return r.label;
  }
  return null;
}

async function fetchSiteSnippet(url, timeoutMs = 8000) {
  if (!url) return '';
  // De-encode the GBP-tracking URLs we see in the sheet (?utm_source=gbp etc — encoded as %3F)
  let cleanUrl = url;
  try { cleanUrl = decodeURIComponent(url.replace(/%25/g, '%')); } catch {}
  cleanUrl = cleanUrl.split(/[?#]/)[0];

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(cleanUrl, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThriveAIVisibility/1.0)' }
    });
    clearTimeout(t);
    if (!r.ok) return '';
    const html = await r.text();
    // Extract title + meta description + first 800 chars of visible text
    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [, ''])[1].trim();
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i) || [, ''])[1].trim();
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);
    return `${title}\n${desc}\n${stripped}`;
  } catch {
    return '';
  }
}

async function classifyByWebsite(companyName, url) {
  const snippet = await fetchSiteSnippet(url);
  if (!snippet) return null;

  // Re-run keyword rules over the page content first (cheap)
  const hit = classifyByName(snippet);
  if (hit) return hit;

  // GPT fallback — only if keyword rules failed on both name and page content
  const knownLabels = [...new Set(RULES.map(r => r.label))];
  const prompt = `Given this company info, return a SHORT industry label that a real customer would use when searching for them on Google or ChatGPT (e.g. "best [LABEL] in Houston").

Company: ${companyName}
Website snippet: ${snippet.slice(0, 600)}

Pick from this list when possible: ${knownLabels.join(', ')}.
If nothing fits, return a 2-4 word label like "tile installation" or "epoxy flooring".
Return ONLY the label, lowercase, no quotes, no extra words.`;

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 20
    });
    return (res.choices[0].message.content || '').trim().toLowerCase().replace(/[".]/g, '');
  } catch {
    return null;
  }
}

// Confidence levels:
//   high   - clear keyword match in the company name
//   medium - keyword match found in scraped website content
//   low    - GPT picked a label (no keyword hit anywhere)
//   review - nothing fit; using generic fallback (NEEDS HUMAN REVIEW)
async function classify(companyName, url) {
  const fromName = classifyByName(companyName);
  if (fromName) return { label: fromName, source: 'name', confidence: 'high' };

  // Try the website: split into "keyword hit on page" vs "GPT picked"
  const snippet = await fetchSiteSnippet(url);
  if (snippet) {
    const keywordHit = classifyByName(snippet);
    if (keywordHit) return { label: keywordHit, source: 'website', confidence: 'medium' };

    const knownLabels = [...new Set(RULES.map(r => r.label))];
    const prompt = `Given this company info, return a SHORT industry label that a real customer would use when searching for them on Google or ChatGPT (e.g. "best [LABEL] in Houston").

Company: ${companyName}
Website snippet: ${snippet.slice(0, 600)}

Pick from this list when possible: ${knownLabels.join(', ')}.
If nothing fits, return a 2-4 word label like "tile installation" or "epoxy flooring".
Return ONLY the label, lowercase, no quotes, no extra words.`;
    try {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 20
      });
      const label = (res.choices[0].message.content || '').trim().toLowerCase().replace(/[".]/g, '');
      if (label) return { label, source: 'gpt', confidence: 'low' };
    } catch {}
  }

  return { label: 'home services', source: 'fallback', confidence: 'review' };
}

module.exports = { classify, classifyByName };
