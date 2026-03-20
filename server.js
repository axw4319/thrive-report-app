const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BASE = 'https://api.peec.ai/customer/v1';

app.post('/proxy', async (req, res) => {
  const { method = 'GET', apiPath, query = {}, body: reqBody, apiKey } = req.body || {};
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE}/${apiPath}${qs ? '?' + qs : ''}`;
  console.log(`[PROXY] ${method} ${url}`);

  try {
    const headers = { 'Content-Type': 'application/json', 'X-API-Key': apiKey || '' };
    const opts = { method, headers };
    if (method === 'POST' && reqBody) opts.body = JSON.stringify(reqBody);

    const r = await fetch(url, opts);
    const text = await r.text();
    console.log(`  => ${r.status} (${text.slice(0, 150)})`);

    // Always try to parse as JSON; if that fails, wrap in JSON
    try {
      const data = JSON.parse(text);
      return res.status(r.status).json(data);
    } catch {
      return res.status(r.status).json({ error: text.trim() || `HTTP ${r.status}`, status: r.status });
    }
  } catch (e) {
    console.error(`  ERR: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4200;
app.listen(PORT, () => console.log(`\n  ✅  http://localhost:${PORT}\n`));
