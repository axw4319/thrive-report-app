// Fuzzy brand matching utilities

// Only strip common legal/corporate suffixes, NOT industry words like "investment", "bank", "venture"
const SUFFIXES = /\b(inc|llc|corp|corporation|ltd|limited|co|company|lp|llp|plc|pllc|pc|pa)\b\.?/gi;

function normalize(name) {
  return name
    .toLowerCase()
    .replace(SUFFIXES, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(str) {
  const s = new Set();
  for (let i = 0; i < str.length - 1; i++) {
    s.add(str.slice(i, i + 2));
  }
  return s;
}

function jaccard(a, b) {
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Match a company name against a list of Peec brands.
 * Returns { brand, score } or null if no match >= threshold.
 */
function matchBrand(companyName, brands, threshold = 0.82) {
  const normCompany = normalize(companyName);
  if (!normCompany || normCompany.length < 3) return null;

  let best = null;
  let bestScore = 0;

  for (const brand of brands) {
    const normBrand = normalize(brand.name);
    if (!normBrand || normBrand.length < 3) continue;

    // Exact match after normalization
    if (normCompany === normBrand) {
      return { brand, score: 1.0 };
    }

    // Check if brand name appears as a word-boundary match in company name (or vice versa)
    const shorter = normCompany.length <= normBrand.length ? normCompany : normBrand;
    const longer = normCompany.length > normBrand.length ? normCompany : normBrand;
    if (shorter.length >= 5 && longer.includes(shorter)) {
      // Check if the shorter string appears at a word boundary in the longer string
      const wordBoundary = new RegExp('\\b' + shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      const isWordMatch = wordBoundary.test(longer);
      const coverage = shorter.length / longer.length;

      if (coverage >= 0.5) {
        // High coverage containment
        const containScore = 0.85;
        if (containScore > bestScore) { bestScore = containScore; best = brand; }
        continue;
      } else if (isWordMatch && shorter.length >= 6) {
        // Brand name is a full word in the company name (e.g. "Intrepid" in "Intrepid Investment Bankers")
        const containScore = 0.85;
        if (containScore > bestScore) { bestScore = containScore; best = brand; }
        continue;
      }
    }

    // Jaccard similarity on bigrams
    const score = jaccard(normCompany, normBrand);
    if (score > bestScore) {
      bestScore = score;
      best = brand;
    }
  }

  if (bestScore >= threshold && best) {
    return { brand: best, score: bestScore };
  }
  return null;
}

module.exports = { normalize, jaccard, matchBrand };
