const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'reports.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_name TEXT NOT NULL,
    website_url TEXT NOT NULL,
    industry TEXT,
    services TEXT,
    location TEXT,
    target_market TEXT,
    website_summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    status TEXT DEFAULT 'pending',
    progress TEXT DEFAULT '',
    prompt_clusters TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    prompt_text TEXT NOT NULL,
    category TEXT,
    FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_id INTEGER NOT NULL,
    model_name TEXT NOT NULL,
    raw_response TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS brand_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id INTEGER NOT NULL,
    brand_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    position INTEGER,
    context_snippet TEXT,
    sentiment_score REAL DEFAULT 0,
    FOREIGN KEY (response_id) REFERENCES responses(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    brand_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    visibility_pct REAL DEFAULT 0,
    market_share_pct REAL DEFAULT 0,
    avg_rank REAL DEFAULT 0,
    mention_count INTEGER DEFAULT 0,
    avg_sentiment REAL DEFAULT 0,
    FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE CASCADE
  );

  -- Cache: AI model responses keyed by (prompt_text, model_name), 7-day TTL
  CREATE TABLE IF NOT EXISTS response_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_text TEXT NOT NULL,
    model_name TEXT NOT NULL,
    response TEXT,
    brands_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(prompt_text, model_name)
  );

  -- Cache: generated prompts per industry, 7-day TTL
  CREATE TABLE IF NOT EXISTS prompt_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    industry TEXT NOT NULL UNIQUE,
    prompts_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Helpers
const createScan = db.prepare(`INSERT INTO scans (brand_name, website_url, prompt_clusters, status) VALUES (?, ?, ?, 'pending')`);
const updateScan = db.prepare(`UPDATE scans SET industry=?, services=?, location=?, target_market=?, website_summary=?, status=?, progress=? WHERE id=?`);
const updateScanStatus = db.prepare(`UPDATE scans SET status=?, progress=? WHERE id=?`);
const completeScan = db.prepare(`UPDATE scans SET status='complete', completed_at=CURRENT_TIMESTAMP, progress='Done' WHERE id=?`);
const getScan = db.prepare(`SELECT * FROM scans WHERE id=?`);
const getAllScans = db.prepare(`SELECT id, brand_name, website_url, status, created_at, completed_at FROM scans ORDER BY created_at DESC`);
const deleteScan = db.prepare(`DELETE FROM scans WHERE id=?`);

const insertPrompt = db.prepare(`INSERT INTO prompts (scan_id, prompt_text, category) VALUES (?, ?, ?)`);
const getPrompts = db.prepare(`SELECT * FROM prompts WHERE scan_id=?`);

const insertResponse = db.prepare(`INSERT INTO responses (prompt_id, model_name, raw_response) VALUES (?, ?, ?)`);
const getResponses = db.prepare(`SELECT r.*, p.prompt_text, p.category FROM responses r JOIN prompts p ON r.prompt_id=p.id WHERE p.scan_id=?`);

const insertMention = db.prepare(`INSERT INTO brand_mentions (response_id, brand_name, normalized_name, position, context_snippet, sentiment_score) VALUES (?, ?, ?, ?, ?, ?)`);
const getMentions = db.prepare(`SELECT bm.*, r.model_name, p.prompt_text, p.category FROM brand_mentions bm JOIN responses r ON bm.response_id=r.id JOIN prompts p ON r.prompt_id=p.id WHERE p.scan_id=?`);

const insertMetric = db.prepare(`INSERT INTO metrics (scan_id, brand_name, normalized_name, visibility_pct, market_share_pct, avg_rank, mention_count, avg_sentiment) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const getMetrics = db.prepare(`SELECT * FROM metrics WHERE scan_id=? ORDER BY visibility_pct DESC`);
const clearMetrics = db.prepare(`DELETE FROM metrics WHERE scan_id=?`);

// Response cache (7-day TTL)
const getCachedResponse = db.prepare(`SELECT response, brands_json FROM response_cache WHERE prompt_text=? AND model_name=? AND created_at > datetime('now', '-7 days')`);
const upsertCachedResponse = db.prepare(`INSERT INTO response_cache (prompt_text, model_name, response, brands_json) VALUES (?, ?, ?, ?) ON CONFLICT(prompt_text, model_name) DO UPDATE SET response=excluded.response, brands_json=excluded.brands_json, created_at=CURRENT_TIMESTAMP`);
const purgeExpiredCache = db.prepare(`DELETE FROM response_cache WHERE created_at <= datetime('now', '-7 days')`);

// Prompt cache (7-day TTL, keyed by industry)
const getCachedPrompts = db.prepare(`SELECT prompts_json FROM prompt_cache WHERE industry=? AND created_at > datetime('now', '-7 days')`);
const upsertCachedPrompts = db.prepare(`INSERT INTO prompt_cache (industry, prompts_json) VALUES (?, ?) ON CONFLICT(industry) DO UPDATE SET prompts_json=excluded.prompts_json, created_at=CURRENT_TIMESTAMP`);

module.exports = {
  db, createScan, updateScan, updateScanStatus, completeScan,
  getScan, getAllScans, deleteScan,
  insertPrompt, getPrompts,
  insertResponse, getResponses,
  insertMention, getMentions,
  insertMetric, getMetrics, clearMetrics,
  getCachedResponse, upsertCachedResponse, purgeExpiredCache,
  getCachedPrompts, upsertCachedPrompts
};
