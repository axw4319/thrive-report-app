#!/usr/bin/env python3
"""E2E tests for thrive-report-app (Live Audit + Peec Report + Bulk CSV).

Usage:
  BASE_URL=http://localhost:3000 ADMIN_PASSWORD=... python3 tests/playwright/test_report_app.py
  BASE_URL=https://thrive-report-app.onrender.com ADMIN_PASSWORD=... python3 tests/playwright/test_report_app.py

Set RUN_LIVE_AUDIT=1 to include the full live-audit run (~40-60s, costs API calls).
Exits non-zero on any failure.
"""
import os, sys, time, json, urllib.request

BASE = os.environ.get('BASE_URL', 'http://localhost:3000')
PASSWORD = os.environ.get('ADMIN_PASSWORD', '')
RUN_LIVE = os.environ.get('RUN_LIVE_AUDIT', '0') == '1'

FAILURES = []
def check(name, cond, detail=''):
    status = 'PASS' if cond else 'FAIL'
    print(f'  [{status}] {name}' + (f' — {detail}' if detail and not cond else ''))
    if not cond:
        FAILURES.append(name)

def main():
    from playwright.sync_api import sync_playwright
    js_errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={'width': 1280, 'height': 900})
        pg.on('pageerror', lambda e: js_errors.append(str(e)))

        print('\n== Auth ==')
        pg.goto(BASE + '/login')
        check('login page loads', pg.is_visible('input[type=password]'))
        pg.fill('input[type=password]', PASSWORD)
        pg.click('button')
        pg.wait_for_load_state('networkidle')
        check('login redirects off /login', '/login' not in pg.url)

        print('\n== Page shells ==')
        for path, label in [('/live-audit.html', 'Live Audit'), ('/', 'Peec Report'), ('/csv.html', 'Bulk CSV')]:
            pg.goto(BASE + path)
            pg.wait_for_load_state('networkidle')
            check(f'{path} shows white logo', pg.is_visible('img[src="/logo-white.png"]'))
            body = pg.text_content('body') or ''
            check(f'{path} labeled "{label}" beside logo', label in body)
            for target in ['/live-audit.html', '/', '/csv.html']:
                check(f'{path} nav links to {target}', pg.locator(f'a[href="{target}"]').count() >= 1)

        print('\n== Live Audit form ==')
        pg.goto(BASE + '/live-audit.html')
        check('no hero heading (deleted)', pg.locator('header h1').count() == 0)
        hint = pg.text_content('body') or ''
        check('city hint mentions national search', 'national search' in hint.lower())
        check('industry override field present', pg.is_visible('#industry'))
        # progress bar elements exist
        for sel in ['#pct', '#pfill', '#phase']:
            check(f'progress element {sel} present', pg.locator(sel).count() == 1)

        print('\n== Peec Report light theme ==')
        pg.goto(BASE + '/')
        bg = pg.eval_on_selector('body', 'el => getComputedStyle(el).backgroundColor')
        check('body background is light', bg in ('rgb(245, 247, 242)',), bg)
        hdr_bg = pg.eval_on_selector('.hdr', 'el => getComputedStyle(el).backgroundImage')
        check('header uses green gradient', 'linear-gradient' in hdr_bg, hdr_bg)

        print('\n== API validation ==')
        resp = pg.request.post(BASE + '/api/live-audit', data=json.dumps({'city': 'Dallas, TX'}),
                               headers={'Content-Type': 'application/json'})
        check('missing company rejected with 400', resp.status == 400)

        if RUN_LIVE:
            print('\n== Full live audit run (national, with industry override) ==')
            pg.goto(BASE + '/live-audit.html')
            pg.fill('#company', 'G-FORCE Parking Lot Striping')
            pg.fill('#website', 'https://www.gogforce.com/')
            # city intentionally blank -> national search
            pg.fill('#industry', 'parking lot striping')
            pg.click('#go')
            saw_progress = []
            done = False
            t0 = time.time()
            while time.time() - t0 < 240:
                time.sleep(5)
                pct = (pg.text_content('#pct') or '0%').strip('%')
                saw_progress.append(int(pct or 0))
                if pg.eval_on_selector('#result', 'el => getComputedStyle(el).display') != 'none':
                    done = True
                    break
            check('audit completed', done, f'progress trail: {saw_progress}')
            if done:
                check('progress increased monotonically', saw_progress == sorted(saw_progress), str(saw_progress))
                check('progress passed a real midpoint', any(0 < v < 100 for v in saw_progress), str(saw_progress))
                check('detected industry shown', 'striping' in (pg.text_content('#r-industry') or ''))
                pdf = pg.get_attribute('#r-pdf', 'href')
                check('PDF link present', bool(pdf))
                r = urllib.request.urlopen(pdf)
                blob = r.read()
                check('PDF serves as application/pdf', r.headers.get('Content-Type') == 'application/pdf')
                check('PDF is substantial (>100KB)', len(blob) > 100_000, f'{len(blob)} bytes')
                print(f'  audit took {round(time.time() - t0)}s — {pdf}')

        b.close()

    print('\n== Console ==')
    check('no JS page errors across all pages', not js_errors, '; '.join(js_errors[:3]))

    print(f'\n{"ALL PASS" if not FAILURES else "FAILURES: " + ", ".join(FAILURES)}')
    sys.exit(1 if FAILURES else 0)

if __name__ == '__main__':
    if not PASSWORD:
        print('ADMIN_PASSWORD env var required'); sys.exit(2)
    main()
