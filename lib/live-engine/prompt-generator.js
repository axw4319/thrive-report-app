// City-localized prompt generator for the AI Visibility batch pipeline.
// Produces 5 search prompts that real buyers in {city} would type into ChatGPT/Gemini/Perplexity/Google
// when looking for {industry} providers — designed to surface DIRECT local competitors.

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateLocalPrompts(industry, city) {
  const isNational = !city || !String(city).trim();
  const geoRule = isNational
    ? `1. Prompts must NOT mention any city or state — phrase them nationally (e.g. "best ${industry} companies", "top ${industry} providers in the US") so responses surface national competitors.`
    : `1. Every prompt MUST mention "${city}" (or a close geographic variant like the city's name without state) so responses surface local competitors only.`;
  const prompt = `Generate exactly 5 high-intent search prompts a buyer ${isNational ? 'anywhere in the US' : 'in ' + city} would type into ChatGPT, Gemini, Perplexity, or Google AI Overviews when looking for a ${industry} provider.

CRITICAL RULES:
${geoRule}
2. Every prompt MUST naturally produce a LIST of competing companies — not generic advice.
3. Use varied formats across the 5 prompts: "best X in Y", "top X for Y", "who are the top X in Y", "recommend X companies in Y", "compare X providers in Y", "which companies offer X in Y", "alternatives to the leading X in Y".
4. At least one prompt should be a comparison/alternatives query.
5. At least one prompt should be a service-specific niche query (e.g. an emergency or premium variant of the service).
6. Keep prompts under 18 words. Real buyers don't type essays.

Categorize each prompt as: discovery, comparison, service, recommendation, or niche.

Return ONLY a JSON array — no markdown — like:
[{"prompt": "best ${industry}${isNational ? ' companies' : ' in ' + city}", "category": "discovery"}, ...]`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 600
  });

  const content = res.choices[0].message.content || '';
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Prompt generator returned non-JSON: ' + content.slice(0, 200));
  }
}

module.exports = { generateLocalPrompts };
