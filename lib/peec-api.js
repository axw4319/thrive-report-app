// Server-side Peec.ai API client
const fetch = require('node-fetch');
const BASE = 'https://api.peec.ai/customer/v1';

class PeecAPI {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.headers = {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey
    };
  }

  async request(method, path, query = {}, body = null) {
    const qs = new URLSearchParams(query).toString();
    const url = `${BASE}/${path}${qs ? '?' + qs : ''}`;
    const opts = { method, headers: this.headers };
    if (method === 'POST' && body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`API error ${r.status}: ${text.slice(0, 200)}`);
    }
  }

  async getProjects() {
    const res = await this.request('GET', 'projects');
    return res.data || [];
  }

  async getBrands(projectId) {
    const res = await this.request('GET', 'brands', { project_id: projectId });
    return res.data || [];
  }

  async getPrompts(projectId) {
    const res = await this.request('GET', 'prompts', { project_id: projectId });
    return res.data || [];
  }

  async getModels(projectId) {
    const res = await this.request('GET', 'models', { project_id: projectId });
    return (res.data || []).filter(m => m.is_active);
  }

  async getBrandReport(projectId, dateBody = {}) {
    const res = await this.request('POST', 'reports/brands', { project_id: projectId }, dateBody);
    return res.data || [];
  }

  async getBrandReportByModel(projectId, dateBody = {}) {
    const res = await this.request('POST', 'reports/brands', { project_id: projectId }, { ...dateBody, dimensions: ['model_id'] });
    return res.data || [];
  }

  async getBrandReportByPrompt(projectId, dateBody = {}) {
    const res = await this.request('POST', 'reports/brands', { project_id: projectId }, { ...dateBody, dimensions: ['prompt_id'] });
    return res.data || [];
  }
}

// Get date range body for last N days
// NOTE: Peec API uses start_date/end_date (NOT date_from/date_to)
function getDates(days) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  return {
    start_date: start.toISOString().split('T')[0],
    end_date: end.toISOString().split('T')[0]
  };
}

module.exports = { PeecAPI, getDates };
