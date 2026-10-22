#!/usr/bin/env node
/**
 * Error-state gallery (#2857). `pnpm chaos:gallery [--sample 15 | --all] [--base http://localhost:3533]
 *   [--start-admin] [--api-target http://localhost:3233] [--routes /a,/b] [--concurrency 3] [--record <url>]`
 *
 * Walks the admin routes (parsed from admin/src/App.tsx; `:param` segments get a sample id) with
 * every /api call answered by a mock, under three faults: 500 with a realistic error body, a
 * request that never answers (hang), and offline. Light + dark, 1440 wide. /api/auth/me always
 * answers a signed-in admin so no real sign-in is needed; socket.io is aborted.
 *
 * Flags per shot: blank (no text in the outlet), raw-error (stack / axios / [object Object] text
 * visible), stuck-loading (spinner or skeleton still there after 10 s), page-error (uncaught
 * exception), error-boundary (the crash screen), no-error-shown (a failed request and no word of it: an empty state or stale-looking content). Output: reports/error-gallery/<date>/index.html
 * (gitignored) + summary.json. Needs only a vite dev server for the admin: --start-admin starts
 * one on the --base port with its own cache dir and kills it afterwards.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { finish, getJson, parseArgs, repoRoot, sleep, waitFor } from './lib.mjs'

const args = parseArgs()
const base = String(args.base ?? 'http://localhost:3533')
const apiTarget = String(args['api-target'] ?? 'http://localhost:3233')
const concurrency = Number(args.concurrency ?? 3)
const settleMs = 10_000
const started_at = new Date().toISOString()
const day = new Date().toISOString().slice(0, 10)
const outDir = resolve(repoRoot, 'reports/error-gallery', day)
mkdirSync(resolve(outDir, 'shots'), { recursive: true })

// ── routes ──────────────────────────────────────────────────────────────────
function discoverRoutes() {
  const src = readFileSync(resolve(repoRoot, 'admin/src/App.tsx'), 'utf8')
  const start = src.indexOf('<Route index')
  const paths = []
  for (const m of src.slice(start).matchAll(/<Route\s+path='([^']+)'/g)) paths.push(m[1])
  const sample = (p) =>
    `/${p.replace(/:[A-Za-z]+/g, (x) => (/id$/i.test(x) ? '1' : 'sample')).replace(/\*/g, 'x')}`.replace(/\/+/g, '/')
  return ['/', ...new Set(paths.map(sample))]
}
let routes = args.routes ? String(args.routes).split(',') : discoverRoutes()
const total = routes.length
if (!args.routes && !args.all) {
  const n = Number(args.sample ?? 15)
  if (routes.length > n) {
    const step = routes.length / n
    routes = Array.from({ length: n }, (_, i) => routes[Math.floor(i * step)])
  }
}

// ── mocks ───────────────────────────────────────────────────────────────────
const ME = {
  data: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'gallery@example.test',
    first_name: 'Gallery',
    last_name: 'Admin',
    status: 'active',
    is_admin: true,
    role_name: 'Administrator',
    app_access: true,
    has_reports: false,
    preferences: {},
    current_workspace: null,
    config_epoch: null
  }
}
const ERROR_BODY = {
  statusCode: 500,
  error: 'Internal Server Error',
  message: 'Something went wrong on our side. Try again in a moment.',
  code: 'INTERNAL_ERROR'
}
const SCENARIOS = ['error-500', 'hang', 'offline']

async function install(page, scenario) {
  await page.route('**/socket.io/**', (r) => r.abort())
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/auth/me')
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) })
    if (scenario === 'error-500')
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify(ERROR_BODY) })
    if (scenario === 'offline') return route.abort('internetdisconnected')
    // hang: never answered; the page's own timeout (if any) is what is being tested
  })
}

// ── per-shot inspection (runs in the page) ──────────────────────────────────
function inspect() {
  const out = document.querySelector('#main-content')
  const text = (out?.innerText ?? '').trim()
  const loadingSel =
    '[class*="animate-spin"],[class*="animate-pulse"],[class*="nvr-skeleton"],[data-skeleton],[role="progressbar"],[aria-busy="true"]'
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
  }
  const loading = out ? [...out.querySelectorAll(loadingSel)].filter(visible).length : 0
  const raw =
    /AxiosError|Request failed with status code|Network Error|\[object Object\]|ERR_INTERNET|ECONN|TypeError:|ReferenceError:|Cannot read propert|is not a function|undefined is not|\bat [\w$.<>]+ \(|<anonymous>/.exec(
      text
    )
  const boundary = /something went wrong|unexpected error|application error/i.test(text)
  const saysError =
    /error|failed|couldn.?t|could not|unable|try again|retry|offline|went wrong|unavailable|unreachable|not reachable|connection/i.test(
      text
    )
  return { saysError, textLen: text.length, loading, raw: raw?.[0] ?? null, boundary, sample: text.slice(0, 160) }
}

async function shoot(browser, job) {
  const { route, scenario, theme } = job
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('nivaro-theme', t)
    } catch {}
  }, theme)
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)))
  await install(page, scenario)
  const t0 = Date.now()
  let nav = 'ok'
  try {
    await page.goto(`${base}${route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  } catch (e) {
    nav = `goto failed: ${e.message.split('\n')[0]}`
  }
  await page.waitForSelector('#main-content', { timeout: 20_000 }).catch(() => {})
  await sleep(2500)
  let state = await page.evaluate(inspect).catch(() => null)
  // Loading indicators get until 10 s after navigation to clear.
  while (state && state.loading > 0 && Date.now() - t0 < settleMs + 2500) {
    await sleep(500)
    state = await page.evaluate(inspect).catch(() => state)
  }
  const id = `${route === '/' ? 'home' : route.replace(/\W+/g, '_').replace(/^_|_$/g, '')}__${scenario}__${theme}`
  await page.screenshot({ path: resolve(outDir, 'shots', `${id}.png`) }).catch(() => {})
  await ctx.close().catch(() => {})
  const flags = []
  if (!state) flags.push('page-error')
  else {
    if (state.textLen === 0) flags.push('blank')
    if (state.raw) flags.push('raw-error')
    if (state.loading > 0) flags.push('stuck-loading')
    if (state.boundary) flags.push('error-boundary')
    // The request failed and the screen shows content or an empty state, with no word of it.
    if (scenario !== 'hang' && state.textLen > 0 && state.loading === 0 && !state.saysError)
      flags.push('no-error-shown')
  }
  if (pageErrors.length) flags.push('page-error')
  return { id, route, scenario, theme, flags: [...new Set(flags)], state, pageErrors, nav }
}

// ── driver ──────────────────────────────────────────────────────────────────
let vite = null
if (args['start-admin']) {
  const port = new URL(base).port || '3533'
  vite = spawn('npx', ['vite', '--port', port, '--strictPort', '--host', '127.0.0.1'], {
    cwd: resolve(repoRoot, 'admin'),
    env: { ...process.env, VITE_CACHE_DIR: resolve(tmpdir(), 'vite-c-ci'), NIVARO_API_TARGET: apiTarget },
    stdio: 'ignore'
  })
}
const cleanup = () => vite?.kill('SIGTERM')
process.on('exit', cleanup)
if (!(await waitFor(async () => (await fetch(base)).ok, { timeoutMs: 120_000, everyMs: 1000 }))) {
  console.error(`admin not reachable at ${base} (use --start-admin or start vite yourself)`)
  cleanup()
  process.exit(2)
}

const { chromium } = createRequire(resolve(repoRoot, 'package.json'))('@playwright/test')
const browser = await chromium.launch()
const jobs = routes.flatMap((route) =>
  SCENARIOS.flatMap((scenario) => ['light', 'dark'].map((theme) => ({ route, scenario, theme })))
)
console.log(`error gallery: ${routes.length} of ${total} routes × ${SCENARIOS.length} faults × 2 themes = ${jobs.length} shots`)
const results = []
let next = 0
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      const r = await shoot(browser, job).catch((e) => ({ ...job, id: `${job.route}-${job.scenario}-${job.theme}`, flags: ['page-error'], state: null, pageErrors: [e.message], nav: 'crashed' }))
      results.push(r)
      console.log(`${r.flags.length ? 'FLAG' : 'ok  '} ${r.route} ${r.scenario} ${r.theme} ${r.flags.join(',')}`)
    }
  })
)
await browser.close()
cleanup()

results.sort((a, b) => a.route.localeCompare(b.route) || a.scenario.localeCompare(b.scenario) || a.theme.localeCompare(b.theme))
const FLAGS = ['blank', 'raw-error', 'stuck-loading', 'no-error-shown', 'page-error', 'error-boundary']
const counts = Object.fromEntries(FLAGS.map((f) => [f, results.filter((r) => r.flags.includes(f)).length]))
const flagged = results.filter((r) => r.flags.length)
writeFileSync(resolve(outDir, 'summary.json'), `${JSON.stringify({ date: day, routes, counts, shots: results.length, flagged: flagged.length, results }, null, 2)}\n`)

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
writeFileSync(
  resolve(outDir, 'index.html'),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error-state gallery ${day}</title>
<style>
:root{--bg:#f8fafc;--card:#fff;--ink:#0f172a;--mute:#64748b;--line:#e2e8f0;--bad:#b91c1c;--badbg:#fee2e2}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--card:#111a2e;--ink:#e2e8f0;--mute:#94a3b8;--line:#1e293b;--bad:#fca5a5;--badbg:#450a0a}}
body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 system-ui,sans-serif}
header{padding:16px;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:12px;align-items:center}
h1{font-size:15px;margin:0 12px 0 0}label{display:inline-flex;gap:4px;align-items:center;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:16px}
.c{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}.c img{width:100%;display:block;border-bottom:1px solid var(--line)}
.m{padding:8px 10px}.m b{display:block;overflow-wrap:anywhere}.m span{color:var(--mute)}.f{display:inline-block;margin:4px 4px 0 0;padding:1px 6px;border-radius:4px;background:var(--badbg);color:var(--bad);font-size:11px}
.hide{display:none}.sum{color:var(--mute)}
</style></head><body><header><h1>Error-state gallery ${day}</h1>
<span class="sum">${results.length} shots, ${flagged.length} flagged. ${FLAGS.map((f) => `${f} ${counts[f]}`).join(' · ')}</span>
<span>${FLAGS.map((f) => `<label><input type="checkbox" data-flag="${f}"> ${f}</label>`).join(' ')}</span>
<span>${SCENARIOS.map((s) => `<label><input type="checkbox" data-sc="${s}" checked> ${s}</label>`).join(' ')}
<label><input type="checkbox" data-th="light" checked> light</label><label><input type="checkbox" data-th="dark" checked> dark</label></span></header>
<div class="grid">${results
    .map(
      (r) => `<div class="c" data-flags="${r.flags.join(' ')}" data-sc="${r.scenario}" data-th="${r.theme}"><a href="shots/${esc(r.id)}.png"><img loading="lazy" src="shots/${esc(r.id)}.png" alt="${esc(r.route)} ${r.scenario} ${r.theme}"></a><div class="m"><b>${esc(r.route)}</b><span>${r.scenario} · ${r.theme}</span><div>${r.flags.map((f) => `<span class="f">${f}</span>`).join('') || '<span>clean</span>'}</div>${r.state?.raw ? `<div><span>raw: ${esc(r.state.raw)}</span></div>` : ''}</div></div>`
    )
    .join('')}</div>
<script>
const q=(s)=>[...document.querySelectorAll(s)];
function apply(){const fl=q('[data-flag]:checked').map(e=>e.dataset.flag),sc=q('input[data-sc]:checked').map(e=>e.dataset.sc),th=q('input[data-th]:checked').map(e=>e.dataset.th);
q('.c').forEach(c=>{const ok=sc.includes(c.dataset.sc)&&th.includes(c.dataset.th)&&(!fl.length||fl.some(f=>c.dataset.flags.split(' ').includes(f)));c.classList.toggle('hide',!ok)})}
q('input').forEach(i=>i.addEventListener('change',apply));
</script></body></html>`
)
console.log(`gallery: ${resolve(outDir, 'index.html')}`)
console.log(`flags: ${JSON.stringify(counts)}`)

await finish(args, {
  script: 'error-gallery',
  fault_key: 'ci.gallery',
  label: 'Error-state gallery',
  verdict: flagged.length === 0 ? 'held' : 'broke',
  metrics: { routes: routes.length, shots: results.length, flagged: flagged.length, ...counts },
  checks: [],
  started_at,
  ended_at: new Date().toISOString(),
  out_dir: outDir
})
process.exit(0)
