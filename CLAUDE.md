# thrive-report-app

**What it is:** White-labeled AI Visibility report generator branded for Thrive Agency. Pulls Peec data + AI search visibility + technical audit, renders branded PDFs. Most mature of the three report-app projects.

**Stack:** Node • Express 4 • Puppeteer • OpenAI + Gemini • Multer • CSV/XLSX • node-fetch
**Repo:** `https://github.com/axw4319/thrive-report-app.git`
**Deploy:** Render (`render.yaml`)
- Build: `npm install && npx puppeteer browsers install chrome`
- Start: `node server.js`
- Persistent disk: 1GB at `/opt/render/project/src/reports`
- Env: `PEEC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `SERPAPI_KEY`, `PERPLEXITY_API_KEY`, `ADMIN_PASSWORD`

## Run
```bash
npm install
npm run build          # installs Chrome for Puppeteer
npm start              # node server.js, port 3000
```

## Layout
- `server.js` — Express server (~15KB)
- `index.html` — branded landing page (~38KB)
- `lib/pdf-generator.js` (~37KB) — Puppeteer rendering
- `lib/csv-processor.js` • `lib/llm-fallback.js` • `lib/fuzzy.js` • `lib/peec-api.js`
- `public/` — frontend + branding
- `reports/` — generated PDF cache (gitignored as of 2026-05-23; lives on Render persistent disk in prod, local disk in dev)
- `tools/` — utility scripts

## Recent work
Auto pre-generate PDFs • Add 444+ pre-generated reports • Fix favicon • Add 233 pre-generated reports • Parallelize Peec API calls.

## Brand
Thrive green `#7D963D`, orange `#FF6600`. Hardcoded — don't accidentally inherit ProCloser or RevFactor palettes.

## Working rules
- **Render env vars: single-var PUT only**, never bulk. See [feedback_render_envvars_no_put.md](/Users/aaronwhittaker/.claude/projects/-Users-aaronwhittaker-Claude/memory/feedback_render_envvars_no_put.md).
- **Test PDF output before claiming done** — use the [qa-flow-tester](/Users/aaronwhittaker/.claude/skills/qa-flow-tester/SKILL.md) skill (tests live at [tests/playwright/specs/](tests/playwright/specs/)). Walk: admin login → CSV upload → report list → PDF download → assert PDF non-empty.
- **Watch persistent disk usage** — 1GB cap on Render. Local dev disk hit 4.8GB / 9k+ PDFs by 2026-05-23; production only holds what the persistent disk can fit.
- **Push after every commit** — see [feedback_always_push_after_commit.md](/Users/aaronwhittaker/.claude/projects/-Users-aaronwhittaker-Claude/memory/feedback_always_push_after_commit.md).
- **TX lead lists: collapse cities to metros first.** Before running `node tools/live-csv/run.js` on any TX lead list, normalize the `Area` column to 4-5 metro buckets (Houston, Dallas, Austin, San Antonio, Other TX) via [tools/live-csv/new-sheet/normalize-to-metros.py](tools/live-csv/new-sheet/normalize-to-metros.py). The pipeline groups by `(city, industry)` and runs 5 prompts × 4 models *per group*. 233 raw cities → 2,802 groups → 4-day ETA + ~22hr wasted API spend (verified 2026-05-22). Metro collapse → ~83 groups → finishes in hours. After Phase 2, grep `unique companies in N (city, industry)` and sanity-check N before walking away. Trade-off accepted: prompts run at metro level not suburb level.

## Don't touch
- `ADMIN_PASSWORD` env var without coordination
- Persistent disk reports cache without backing up first
