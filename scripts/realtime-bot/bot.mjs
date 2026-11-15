#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: command-line tool, the console is its output
/**
 * Realtime test bot (realtime round 3, item 25) — does a change made by one person show on
 * another person's open screen within 2 s, without a reload?
 *
 * It creates two THROWAWAY people (A and B, `rt-bot-…@rt-bot.invalid`, never real people,
 * removed again at the end — also when a check or the setup fails), opens the admin app in
 * headless Chromium as A, makes changes as B through the API and waits for each one to appear
 * on A's screen:
 *
 *   field-edit   B edits a text field of the throwaway record      → A's record page shows it
 *   comment      B comments on the record                          → A's record page shows it
 *   file         B attaches a small text file to the record        → A's record page shows it
 *   line         B adds a child row (a line) under the record      → A's record page shows it
 *   move         B moves the record through a pipeline transition → A's record page shows it
 *   create       B creates a record in the collection             → A's list shows it
 *   delete       B deletes that record                            → A's list no longer shows it
 *
 * Prints a pass/fail table with timings; exits 0 when every check that ran passed, 1 when one
 * failed, 2 when it refused or the options were wrong, 3 when setup failed.
 *
 * Run it against STAGING after a deploy:
 *
 *   npx playwright install chromium            # once per machine
 *   RT_BOT_ADMIN_TOKEN=<an administrator's own static token> \
 *   node scripts/realtime-bot/bot.mjs \
 *     --target https://staging.example.com \
 *     --role <role uuid that may read and update the collection> \
 *     --collection workflows --record 12345 --field notes \
 *     [--line-collection workflow_lines --line-fk workflow --line-field description] \
 *     [--transition <transition uuid> --move-expect "Submitted"] \
 *     [--create-json '{"project": 7}'] [--skip file,move]
 *
 *   node scripts/realtime-bot/bot.mjs --target https://staging.example.com --dry-run
 *
 * Choose the throwaway record and collection with care: B's comment, file, line and move are
 * real writes, so whoever owns or watches that record is told the way they always are. Use a
 * record nobody else follows and a transition with no partner push or mail. `move` cannot be
 * undone; everything else is (the field gets its old value back, the comment, file, line and
 * created record are deleted).
 *
 * Refusals (no override): the target's GET /api/app-info says `production`, or does not
 * answer, or names no environment; a target host name containing prod/production. There is no
 * default target. The admin token must be an administrator's own static token (Profile →
 * Security); an API key or View-as token cannot mint the throwaway people's sign-in tokens.
 * Tokens are never printed.
 *
 * Options: --target (API origin) · --app-url (admin app origin; default the target) ·
 * --admin-token / RT_BOT_ADMIN_TOKEN · --role · --collection · --record · --field ·
 * --list-field (default --field) · --file-field · --line-collection · --line-fk ·
 * --line-field · --transition · --move-expect · --create-json · --skip a,b · --timeout-ms
 * (2000) · --settle-ms (time the page gets after loading before the first check, 1500) ·
 * --headed · --dry-run · --json.
 */
import { pathToFileURL } from 'node:url'

export class UsageError extends Error {}
export class Refusal extends Error {}

export const CHECKS = ['field-edit', 'comment', 'file', 'line', 'move', 'create', 'delete']
const DEFAULT_TIMEOUT_MS = 2000

// ─── Options ─────────────────────────────────────────────────────────────────

export function parseArgs(argv, env = {}) {
  const o = {
    target: null,
    appUrl: null,
    adminToken: env.RT_BOT_ADMIN_TOKEN ?? null,
    role: null,
    collection: null,
    record: null,
    field: null,
    listField: null,
    fileField: null,
    lineCollection: null,
    lineFk: null,
    lineField: null,
    transition: null,
    moveExpect: null,
    createJson: null,
    skip: new Set(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    settleMs: 1500,
    headed: false,
    dryRun: false,
    json: false
  }
  const flags = {
    '--target': 'target',
    '--app-url': 'appUrl',
    '--admin-token': 'adminToken',
    '--role': 'role',
    '--collection': 'collection',
    '--record': 'record',
    '--field': 'field',
    '--list-field': 'listField',
    '--file-field': 'fileField',
    '--line-collection': 'lineCollection',
    '--line-fk': 'lineFk',
    '--line-field': 'lineField',
    '--transition': 'transition',
    '--move-expect': 'moveExpect',
    '--create-json': 'createJson'
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a === '--headed') o.headed = true
    else if (a === '--json') o.json = true
    else if (a === '--skip') {
      for (const s of String(argv[++i] ?? '').split(',')) if (s.trim()) o.skip.add(s.trim())
    } else if (a === '--timeout-ms') o.timeoutMs = Number(argv[++i])
    else if (a === '--settle-ms') o.settleMs = Number(argv[++i])
    else if (flags[a]) {
      const v = argv[++i]
      if (v == null || v.startsWith('--')) throw new UsageError(`${a} needs a value`)
      o[flags[a]] = v
    } else throw new UsageError(`Unknown option ${a}`)
  }
  if (!o.target) throw new UsageError('--target is required (there is no default target)')
  o.target = o.target.replace(/\/+$/, '')
  o.appUrl = (o.appUrl ?? o.target).replace(/\/+$/, '')
  for (const s of o.skip) if (!CHECKS.includes(s)) throw new UsageError(`Unknown check ${s}`)
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) throw new UsageError('Bad --timeout-ms')
  if (o.createJson) {
    try {
      const parsed = JSON.parse(o.createJson)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object')
      o.createJson = parsed
    } catch {
      throw new UsageError('--create-json must be a JSON object')
    }
  }
  if (!o.dryRun) {
    for (const [k, flag] of [
      ['adminToken', '--admin-token (or RT_BOT_ADMIN_TOKEN)'],
      ['role', '--role'],
      ['collection', '--collection'],
      ['record', '--record'],
      ['field', '--field']
    ])
      if (!o[k]) throw new UsageError(`${flag} is required`)
  }
  o.listField = o.listField ?? o.field
  return o
}

/** Which checks run, and why the others do not (pure). */
export function planChecks(o) {
  const out = []
  for (const name of CHECKS) {
    let why = null
    if (o.skip.has(name)) why = 'skipped (--skip)'
    else if (name === 'line' && !(o.lineCollection && o.lineFk && o.lineField))
      why = 'needs --line-collection, --line-fk and --line-field'
    else if (name === 'move' && !(o.transition && o.moveExpect))
      why = 'needs --transition and --move-expect'
    else if (name === 'delete' && o.skip.has('create')) why = 'needs the create check'
    out.push({ name, run: why === null, why })
  }
  return out
}

// ─── The target must not be production ──────────────────────────────────────

export function hostRefusal(target) {
  let host = ''
  try {
    host = new URL(target).hostname.toLowerCase()
  } catch {
    return `Not a URL: ${target}`
  }
  if (/(^|[.-])(prod|production)([.-]|$)/.test(host))
    return `${host} looks like production — the bot never runs there`
  return null
}

/** GET /api/app-info; refuses production, and anything it cannot identify. */
export async function checkTarget(fetchImpl, target) {
  const byHost = hostRefusal(target)
  if (byHost) throw new Refusal(byHost)
  let info
  try {
    const res = await fetchImpl(`${target}/api/app-info`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    info = await res.json()
  } catch (err) {
    throw new Refusal(
      `Could not read ${target}/api/app-info (${err?.message ?? err}) — refusing a target it cannot identify`
    )
  }
  const environment = typeof info?.environment === 'string' ? info.environment : null
  if (!environment) throw new Refusal('The target names no environment — refusing')
  if (environment === 'production') throw new Refusal('The target says it is production — refusing')
  return { environment, version: info?.version ?? null, name: info?.name ?? null }
}

// ─── Cleanup: last in, first out, every step tried ──────────────────────────

export function createCleanup(log = () => {}) {
  const steps = []
  return {
    add(label, fn) {
      steps.push({ label, fn })
    },
    get size() {
      return steps.length
    },
    async run() {
      const results = []
      while (steps.length) {
        const { label, fn } = steps.pop()
        try {
          await fn()
          results.push({ label, ok: true })
        } catch (err) {
          results.push({ label, ok: false, error: String(err?.message ?? err) })
          log(`cleanup: ${label} failed — ${err?.message ?? err}`)
        }
      }
      return results
    }
  }
}

// ─── API ─────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(method, path, status, message) {
    super(`${method} ${path} → ${status}${message ? `: ${message}` : ''}`)
    this.status = status
  }
}

export function apiClient(fetchImpl, target, token) {
  return async (method, path, body) => {
    const res = await fetchImpl(`${target}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      const msg = typeof data?.error === 'string' ? data.error : text.slice(0, 160)
      throw new ApiError(method, path, res.status, msg)
    }
    return data
  }
}

const enc = encodeURIComponent

// ─── The page side ───────────────────────────────────────────────────────────

/**
 * Wait until A's page shows `text` (as text, or as the value of a field) — or, with `gone`,
 * until it no longer does. The predicate runs in the page.
 */
async function waitFor(page, text, gone, timeoutMs, now) {
  const t0 = now()
  try {
    await page.waitForFunction(
      ({ t, g }) => {
        let shows = !!document.body?.innerText?.includes(t)
        if (!shows)
          for (const el of document.querySelectorAll('input, textarea'))
            if (typeof el.value === 'string' && el.value.includes(t)) {
              shows = true
              break
            }
        return g ? !shows : shows
      },
      { t: text, g: gone },
      { timeout: timeoutMs, polling: 50 }
    )
    return { ok: true, ms: now() - t0 }
  } catch {
    return { ok: false, ms: now() - t0 }
  }
}

async function defaultLaunch({ headed }) {
  let pw
  try {
    // The repo's dev dependency is @playwright/test (it carries the same `chromium`).
    pw = await import('@playwright/test').catch(() => import('playwright'))
  } catch {
    throw new Error('Playwright is not installed here (pnpm install, then npx playwright install chromium)')
  }
  return pw.chromium.launch({ headless: !headed })
}

// ─── The run ─────────────────────────────────────────────────────────────────

/**
 * Run the bot. `deps` lets tests replace the network and the browser:
 * `{ fetch, launch, log, now, stamp }`. Resolves to `{ ok, refused?, rows, cleanup }`.
 */
export async function runBot(o, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const launch = deps.launch ?? defaultLaunch
  const log = deps.log ?? ((m) => console.error(m))
  const now = deps.now ?? (() => performance.now())
  const stamp = deps.stamp ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

  let target
  try {
    target = await checkTarget(fetchImpl, o.target)
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, refused: err.message, rows: [], cleanup: [] }
    throw err
  }
  const plan = planChecks(o)
  log(`target ${o.target} — ${target.environment}${target.version ? ` ${target.version}` : ''}`)
  if (o.dryRun) {
    return {
      ok: true,
      dryRun: true,
      target,
      rows: plan.map((p) => ({ check: p.name, result: p.run ? 'would run' : 'skip', ms: null, note: p.why ?? '' }))
    }
  }

  const admin = apiClient(fetchImpl, o.target, o.adminToken)
  const cleanup = createCleanup(log)
  // Ctrl-C mid-run still removes the throwaway people and rows.
  const onSignal = () => {
    log('interrupted — cleaning up')
    void cleanup.run().finally(() => process.exit(130))
  }
  if (deps.handleSignals) process.once('SIGINT', onSignal)
  const rows = []
  let setupError = null
  let browser = null
  try {
    // Two throwaway people. `.invalid` never resolves, so no mail can reach anyone.
    const people = {}
    for (const who of ['a', 'b']) {
      const created = await admin('POST', '/users', {
        email: `rt-bot-${who}-${stamp}@rt-bot.invalid`,
        first_name: 'Realtime bot',
        last_name: who.toUpperCase(),
        role: o.role
      })
      const id = created?.data?.id
      if (!id) throw new Error('The API did not return the new person')
      cleanup.add(`remove throwaway person ${who.toUpperCase()}`, () => admin('DELETE', `/users/${enc(id)}`))
      const minted = await admin('POST', `/users/${enc(id)}/token`)
      const token = minted?.data?.token
      if (!token) throw new Error('The API did not mint a sign-in token')
      cleanup.add(`revoke ${who.toUpperCase()}'s token`, () => admin('DELETE', `/users/${enc(id)}/token`))
      people[who] = { id, token }
    }
    const asB = apiClient(fetchImpl, o.target, people.b.token)
    const rec = `/items/${enc(o.collection)}/${enc(o.record)}`

    // A's browser, signed in with A's token (POST /api/auth/login/token → a normal session).
    browser = await launch({ headed: o.headed })
    const closeBrowser = browser
    cleanup.add('close the browser', () => closeBrowser.close())
    const context = await browser.newContext()
    const signIn = await context.request.post(`${o.appUrl}/api/auth/login/token`, {
      data: { token: people.a.token }
    })
    if (!signIn.ok()) throw new Error(`A could not sign in (HTTP ${signIn.status()})`)
    const page = await context.newPage()

    const check = async (name, act, text, opts = {}) => {
      const p = plan.find((x) => x.name === name)
      if (!p?.run) {
        rows.push({ check: name, result: 'skip', ms: null, note: p?.why ?? '' })
        return
      }
      try {
        await act()
      } catch (err) {
        rows.push({ check: name, result: 'error', ms: null, note: String(err?.message ?? err) })
        return
      }
      const r = await waitFor(page, text, !!opts.gone, o.timeoutMs, now)
      rows.push({
        check: name,
        result: r.ok ? 'pass' : 'FAIL',
        ms: Math.round(r.ms),
        note: r.ok ? '' : `not ${opts.gone ? 'gone' : 'seen'} within ${o.timeoutMs} ms`
      })
    }

    // ── The record page ──
    const before = await asB('GET', `${rec}?fields=${enc(o.field)}`)
    const oldValue = before?.data?.[o.field] ?? null
    await page.goto(`${o.appUrl}/collections/${enc(o.collection)}/${enc(o.record)}`)
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(o.settleMs)

    const fieldText = `rt-bot ${stamp} field`
    await check('field-edit', async () => {
      cleanup.add('put the field back', () => asB('PATCH', rec, { [o.field]: oldValue }))
      await asB('PATCH', rec, { [o.field]: fieldText })
    }, fieldText)

    const commentText = `rt-bot ${stamp} comment`
    await check('comment', async () => {
      const c = await asB('POST', '/comments', {
        collection: o.collection,
        item: String(o.record),
        text: commentText
      })
      const id = c?.data?.id
      if (id != null) cleanup.add('delete the comment', () => asB('DELETE', `/comments/${enc(id)}`))
    }, commentText)

    const fileName = `rt-bot-${stamp}.txt`
    await check('file', async () => {
      const f = await asB('POST', '/files/attach', {
        collection: o.collection,
        item: String(o.record),
        ...(o.fileField ? { field: o.fileField } : {}),
        filename: fileName,
        type: 'text/plain',
        content_base64: Buffer.from('realtime bot test file\n').toString('base64')
      })
      const id = f?.data?.file?.id
      if (id) cleanup.add('delete the file', () => asB('DELETE', `/files/${enc(id)}`))
    }, fileName)

    const lineText = `rt-bot ${stamp} line`
    await check('line', async () => {
      const l = await asB('POST', `/items/${enc(o.lineCollection)}`, {
        [o.lineFk]: o.record,
        [o.lineField]: lineText
      })
      const id = l?.data?.id
      if (id != null)
        cleanup.add('delete the line', () => asB('DELETE', `/items/${enc(o.lineCollection)}/${enc(id)}`))
    }, lineText)

    await check('move', async () => {
      await asB('POST', `/pipelines/instance/${enc(o.collection)}/${enc(o.record)}/transition`, {
        transition_id: o.transition,
        comment: 'Realtime bot check'
      })
    }, o.moveExpect)

    // ── The list ──
    await page.goto(`${o.appUrl}/collections/${enc(o.collection)}`)
    await page.waitForLoadState('networkidle').catch(() => {})
    await page.waitForTimeout(o.settleMs)
    const createText = `rt-bot ${stamp} new`
    let createdId = null
    await check('create', async () => {
      const r = await asB('POST', `/items/${enc(o.collection)}`, {
        ...(o.createJson ?? {}),
        [o.listField]: createText
      })
      createdId = r?.data?.id ?? null
      if (createdId != null) {
        const id = createdId
        cleanup.add('delete the created record', async () => {
          try {
            await asB('DELETE', `/items/${enc(o.collection)}/${enc(id)}`)
          } catch (err) {
            if (err?.status !== 404 && err?.status !== 403) throw err
          }
        })
      }
    }, createText)
    if (createdId == null && planChecks(o).find((p) => p.name === 'delete')?.run) {
      rows.push({ check: 'delete', result: 'skip', ms: null, note: 'nothing was created' })
    } else {
      await check('delete', () => asB('DELETE', `/items/${enc(o.collection)}/${enc(createdId)}`), createText, {
        gone: true
      })
    }
  } catch (err) {
    setupError = String(err?.message ?? err)
    log(`setup failed: ${setupError}`)
  }
  if (deps.handleSignals) process.off('SIGINT', onSignal)
  const cleaned = await cleanup.run()
  const failed = rows.some((r) => r.result === 'FAIL' || r.result === 'error')
  return { ok: !setupError && !failed, setupError, target, rows, cleanup: cleaned }
}

// ─── Output ──────────────────────────────────────────────────────────────────

export function formatTable(rows) {
  const head = ['check', 'result', 'ms', 'note']
  const body = rows.map((r) => [r.check, r.result, r.ms == null ? '' : String(r.ms), r.note ?? ''])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)))
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n')
}

export function exitCodeFor(result) {
  if (result.refused) return 2
  if (result.setupError) return 3
  return result.ok ? 0 : 1
}

async function main() {
  let o
  try {
    o = parseArgs(process.argv.slice(2), process.env)
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message)
      process.exit(2)
    }
    throw err
  }
  const result = await runBot(o, { handleSignals: true })
  if (o.json) console.log(JSON.stringify(result, null, 2))
  else {
    if (result.refused) console.error(`Refused: ${result.refused}`)
    if (result.rows.length) console.log(formatTable(result.rows))
    const bad = (result.cleanup ?? []).filter((c) => !c.ok)
    if (bad.length) console.error(`Cleanup left ${bad.length} step(s) undone: ${bad.map((b) => b.label).join(', ')}`)
  }
  process.exit(exitCodeFor(result))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err)
    process.exit(3)
  })
}
