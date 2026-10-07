/**
 * release-gate — the post-deploy check the release chain's verify stage runs
 * against an API after it answers the new version (#1045).
 *
 * "It answers /api/version" proves the process booted. It does not prove the
 * deploy is coherent: a deploy whose extension mount failed, whose migrations
 * are still pending, or whose readiness dropped answers the version just as
 * well. So the gate asks four more questions, cheapest first:
 *
 *   GET  /api/ready                    public — boot done, nothing pending,
 *                                      required extensions loaded, DB + Redis
 *   GET  /api/preflight                admin — deploy coherence (503 = fail)
 *   POST /api/ops-runtime/smoke?strict=1  admin — the smoke suite (503 = fail)
 *   GET  /api/readiness                admin — the score must not drop against
 *                                      the snapshot taken before the push
 *
 * The admin checks need a gate token. Without one they are reported as
 * skipped, loudly — the gate cannot invent a credential. A token the API
 * refuses is a FAILURE, never a skip: the deploy was not verified.
 *
 * Pure helpers + one runner taking an injected `request`, so the logic is
 * unit-tested without a network (scripts/release-gate.test.mjs).
 */

import { spawnSync } from 'node:child_process'

/** The API base of a verify URL that points at /api/version, else null. */
export function apiBase(url) {
  if (typeof url !== 'string') return null
  const m = url.match(/^(https?:\/\/[^?#]+?)\/api\/version\/?(?:[?#].*)?$/)
  return m ? m[1] : null
}

/** Ready checks whose failure is the environment's, not the image's. */
const DEPENDENCY_CHECKS = new Set(['database', 'redis'])

/** GET /api/ready → ok, plus whether a failure is only a dependency. */
export function judgeReady(status, body) {
  const checks = Array.isArray(body?.checks) ? body.checks : []
  const failing = checks.filter((c) => c && c.ok === false)
  if (status === 200 && body?.ready === true) return { ok: true, detail: 'ready' }
  const named = failing.map((c) => `${c.id}: ${c.summary ?? 'not ok'}`)
  return {
    ok: false,
    dependencyOnly: failing.length > 0 && failing.every((c) => DEPENDENCY_CHECKS.has(c.id)),
    detail: named.length ? named.join('; ') : `HTTP ${status}`
  }
}

const refused = (status) => status === 401 || status === 403

/** GET /api/preflight → ok unless 503 / status fail; warnings are listed. */
export function judgePreflight(status, body) {
  if (refused(status)) return { ok: false, refused: true, detail: `token refused (HTTP ${status})` }
  const d = body?.data ?? body
  const checks = Array.isArray(d?.checks) ? d.checks : []
  const bad = checks.filter((c) => c?.status === 'fail').map((c) => c.summary ?? c.id)
  const warn = checks.filter((c) => c?.status === 'warn').map((c) => c.summary ?? c.id)
  if (status === 200 && d?.status !== 'fail') {
    return { ok: true, detail: warn.length ? `ok with warnings: ${warn.join('; ')}` : 'ok' }
  }
  return { ok: false, detail: bad.length ? bad.join('; ') : `HTTP ${status}` }
}

/** POST /api/ops-runtime/smoke?strict=1 → ok on 200 with data.ok. */
export function judgeSmoke(status, body) {
  if (refused(status)) return { ok: false, refused: true, detail: `token refused (HTTP ${status})` }
  const d = body?.data ?? body
  if (status === 200 && d?.ok !== false) return { ok: true, detail: 'passed' }
  const checks = Array.isArray(d?.checks) ? d.checks : []
  const bad = checks
    .filter((c) => c && (c.ok === false || c.status === 'fail'))
    .map((c) => `${c.id ?? c.name ?? '?'}${c.detail ? `: ${c.detail}` : ''}`)
  return { ok: false, detail: bad.length ? bad.join('; ') : `HTTP ${status}` }
}

/** A readiness report reduced to what the comparison needs. */
export function readinessSnapshot(body) {
  const d = body?.data ?? body
  if (!d || typeof d !== 'object') return null
  const checks = {}
  for (const c of Array.isArray(d.checks) ? d.checks : []) {
    if (c?.id) checks[c.id] = { status: c.status, label: c.label ?? c.id }
  }
  return { score: typeof d.score === 'number' ? d.score : null, checks }
}

const RANK = { pass: 3, warn: 2, fail: 1, error: 1 }

/**
 * Before vs after. The gate exists to catch a bad IMAGE, so a drop counts only
 * when a check moved INTO fail/error (or a new check arrived failing) — a
 * pass → warn slide, e.g. a vendored procedure the database has not received
 * yet, is reported as a warning and does not block; an unexplained drop does. `worse` names every check
 * that moved down so a drop reads as the checks that caused it, not a bare
 * number; `tolerance` is how far the score may fall before a fail counts.
 */
export function compareReadiness(before, after, tolerance = 0) {
  if (!after) return { ok: false, detail: 'no readiness report after the deploy' }
  if (!before || before.score === null) {
    return { ok: true, detail: `score ${after.score ?? 'n/a'} (no pre-deploy snapshot to compare)` }
  }
  const worse = []
  const failed = []
  for (const [id, a] of Object.entries(after.checks)) {
    const b = before.checks[id]
    if (RANK[a.status] === undefined) continue
    if (!b) {
      if (RANK[a.status] <= RANK.fail) failed.push(`${a.label}: new check, ${a.status}`)
      continue
    }
    if (RANK[b.status] === undefined || RANK[a.status] >= RANK[b.status]) continue
    worse.push(`${a.label}: ${b.status} → ${a.status}`)
    if (RANK[a.status] <= RANK.fail) failed.push(`${a.label}: ${b.status} → ${a.status}`)
  }
  const dropped = after.score === null || after.score < before.score - tolerance
  // A drop is tolerated only when the checks EXPLAIN it as warnings alone;
  // an unexplained drop (no check moved, or the report lost its checks) and
  // any move into fail/error still block.
  const explainedByWarnings = worse.length > 0 && failed.length === 0
  const ok = !dropped || explainedByWarnings
  const detail =
    `score ${before.score} → ${after.score ?? 'n/a'}` +
    (worse.length ? `; worse: ${worse.join('; ')}` : '') +
    (ok && dropped ? ' (warnings only — not blocking)' : '')
  return { ok, detail, worse, failed, warning: ok && (dropped || worse.length > 0) }
}

/**
 * Run the gate against one API. `request(method, path, { auth })` resolves to
 * `{ status, body }` (body parsed JSON or null) and never throws for an HTTP
 * status; a network failure resolves `{ status: 0, body: null, error }`.
 * Returns { ok, lines, failures } — lines are what the chain prints.
 */
export async function runGate({ name, token, request, before, readinessTolerance = 0, settleMs = 60_000, sleep }) {
  const lines = []
  const failures = []
  const step = (label, verdict) => {
    lines.push(`${verdict.ok ? 'ok  ' : 'FAIL'} ${name} ${label}: ${verdict.detail}`)
    if (!verdict.ok) failures.push(`${label}: ${verdict.detail}`)
  }

  const ready = await request('GET', '/api/ready', { auth: false })
  const r = ready.status === 0 ? { ok: false, detail: ready.error ?? 'no answer' } : judgeReady(ready.status, ready.body)
  step('/api/ready', r)

  if (!token) {
    lines.push(
      `WARN ${name}: preflight, smoke and readiness were NOT checked — no gate token (set "gate": { "token_env": "…" } on this verify entry, or a token on its Environments component)`
    )
    return { ok: failures.length === 0, lines, failures, authed: false }
  }

  const pre = await request('GET', '/api/preflight', { auth: true })
  step('/api/preflight', pre.status === 0 ? { ok: false, detail: pre.error ?? 'no answer' } : judgePreflight(pre.status, pre.body))

  const smoke = await request('POST', '/api/ops-runtime/smoke?strict=1', { auth: true })
  step('smoke', smoke.status === 0 ? { ok: false, detail: smoke.error ?? 'no answer' } : judgeSmoke(smoke.status, smoke.body))

  // A readiness check can read a warming cache as a warning for the first
  // minute: one re-read after `settleMs` before calling a drop a drop.
  const readAfter = async () => {
    const res = await request('GET', '/api/readiness', { auth: true })
    if (refused(res.status)) return { refused: true, status: res.status }
    return { snap: res.status === 200 ? readinessSnapshot(res.body) : null, status: res.status }
  }
  let after = await readAfter()
  let cmp = after.refused
    ? { ok: false, detail: `token refused (HTTP ${after.status})` }
    : compareReadiness(before, after.snap, readinessTolerance)
  if (!cmp.ok && !after.refused && before && sleep) {
    lines.push(`     ${name} readiness ${cmp.detail} — re-reading in ${Math.round(settleMs / 1000)}s`)
    await sleep(settleMs)
    after = await readAfter()
    cmp = after.refused
      ? { ok: false, detail: `token refused (HTTP ${after.status})` }
      : compareReadiness(before, after.snap, readinessTolerance)
  }
  step('readiness', cmp)

  return { ok: failures.length === 0, lines, failures, authed: true }
}

/**
 * One HTTP request through curl (node's fetch rejects the corporate staging
 * certificate — see the verify comment below). The token rides curl's stdin
 * as a config line, never argv, so it never shows in `ps`.
 */
export function curlRequest(base, token) {
  return async (method, path, { auth }) => {
    const header = auth && token ? `header = "Authorization: Bearer ${token.replace(/["\\]/g, '')}"\n` : ''
    const res = spawnSync(
      'curl',
      ['-sS', '-m', '180', '-X', method, '-w', '\n%{http_code}', '--config', '-', `${base}${path}`],
      { input: header, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
    if (res.status !== 0) {
      return { status: 0, body: null, error: String(res.stderr || res.error?.message || 'curl failed').trim().split('\n')[0] }
    }
    const out = res.stdout ?? ''
    const cut = out.lastIndexOf('\n')
    const status = Number(out.slice(cut + 1)) || 0
    let body = null
    try {
      body = JSON.parse(out.slice(0, cut))
    } catch {
      /* not JSON — the judges report the status */
    }
    return { status, body }
  }
}
