import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { safeFetch } from '../../../lib/ssrf.js'
import { parseJson } from '../../pipeline-engine.js'
import { strictPinMap } from '../docker/stack-gather.js'
import { scannerEndpoint } from './settings.js'

/**
 * Image vulnerability scan (Hub enhancement 43).
 *
 * Ruling: a SCANNER ENDPOINT the operator sets (Apps → Security → Settings: URL + token), not a
 * scanner inside the Hub agent — the agent stays the narrow, only Docker writer it is (no scanner
 * binary, database or outbound feed in it), and the Hub makes no outbound call at all while no
 * URL is set. The endpoint is any service that speaks this contract (a small wrapper around
 * Trivy, Grype or OSV-Scanner):
 *
 *   POST {url}/scan   Authorization: Bearer <token>   {"image": "<repo>@sha256:<64 hex>"}
 *   200 {"vulnerabilities": [{"id": "CVE-…", "severity": "critical|high|medium|low|unknown",
 *        "package": "openssl", "installed": "3.0.1", "fixed": "3.0.7", "url": "https://…",
 *        "summary": "…"}]}
 *
 * The call goes through safeFetch (pinned address, every redirect re-checked; a scanner on a
 * private address needs SSRF_ALLOW_HOSTS), SCAN_TIMEOUT_MS per image, the answer read up to
 * 8 MB. Only the image reference travels — never a token of the Hub's, an app name or a host.
 *
 * Which images: every PINNED digest the Hub runs — the Nivaro image of each environment's newest
 * successful Docker deploy, the extension pins of each environment, and a shared deployment's
 * image + extension pins (counted for every environment placed on it). Findings are kept per
 * digest (first seen, last seen, resolved when a later scan of the digest no longer lists them).
 */

export const SCANS = 'nivaro_hub_vuln_scans'
export const FINDINGS = 'nivaro_hub_vuln_findings'
export const SCAN_TIMEOUT_MS = 60_000
export const STALE_MS = 5 * 60_000
const MAX_ANSWER_BYTES = 8 * 1024 * 1024
const PIN_RE = /^[^@\s]+@sha256:[0-9a-f]{64}$/
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'unknown'] as const
export type Severity = (typeof SEVERITIES)[number]

export interface PinnedImage {
  image: string
  digest: string
  /** nivaro | extension:<id> */
  role: string
  environment_ids: number[]
}

export interface Vulnerability {
  id: string
  severity: Severity
  package: string
  installed: string | null
  fixed: string | null
  url: string | null
  summary: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const clip = (v: unknown, n: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null

export const digestOf = (image: string) => image.slice(image.indexOf('@') + 1)

/** One scanner entry, normalised; null when unusable. Pure. */
export function readVulnerability(v: unknown): Vulnerability | null {
  if (!isObj(v)) return null
  const id = clip(v.id, 64)
  const pkg = clip(v.package, 200)
  if (!id || !pkg) return null
  const sev = String(v.severity ?? '').toLowerCase()
  const url = clip(v.url, 500)
  return {
    id,
    package: pkg,
    severity: (SEVERITIES as readonly string[]).includes(sev) ? (sev as Severity) : 'unknown',
    installed: clip(v.installed, 100),
    fixed: clip(v.fixed, 100),
    url: url && /^https:\/\//i.test(url) ? url : null,
    summary: clip(v.summary, 500)
  }
}

/** Every pinned image the Hub runs (see the header). */
export async function pinnedImages(): Promise<PinnedImage[]> {
  const byImage = new Map<string, PinnedImage>()
  const add = (image: unknown, role: string, envId: number) => {
    if (typeof image !== 'string' || !PIN_RE.test(image)) return
    const p = byImage.get(image) ?? { image, digest: digestOf(image), role, environment_ids: [] }
    if (!p.environment_ids.includes(envId)) p.environment_ids.push(envId)
    byImage.set(image, p)
  }
  const envs = (await db('nivaro_hub_environments as e')
    .leftJoin('nivaro_hub_placements as p', 'p.id', 'e.placement_id')
    .whereNot('e.status', 'archived')
    .select('e.id', 'e.extension_pins', 'p.kind', 'p.shared_deployment_id')) as Array<
    Record<string, unknown>
  >
  const sharedIds = new Set<number>()
  for (const e of envs) {
    const envId = Number(e.id)
    const pins = strictPinMap(e.extension_pins) ?? {}
    for (const [id, pin] of Object.entries(pins)) add(pin, `extension:${id}`, envId)
    if (e.kind === 'shared' && e.shared_deployment_id != null) {
      sharedIds.add(Number(e.shared_deployment_id))
      continue
    }
    const deploys = (await db('nivaro_hub_deploys')
      .where({ environment_id: envId, status: 'success' })
      .orderBy('id', 'desc')
      .limit(10)
      .select('plan')) as Array<{ plan: unknown }>
    for (const d of deploys) {
      const plan = parseJson(String(d.plan ?? '')) as Record<string, unknown> | null
      const steps = isObj(plan) && Array.isArray(plan.steps) ? plan.steps : []
      const step = steps.find((s) => isObj(s) && s.driver === 'docker') as
        | Record<string, unknown>
        | undefined
      if (!step) continue
      add(step.deployedImage, 'nivaro', envId)
      const ext = strictPinMap(isObj(step.stack) ? step.stack.extensions : undefined) ?? {}
      for (const [id, pin] of Object.entries(ext)) add(pin, `extension:${id}`, envId)
      break
    }
  }
  if (sharedIds.size) {
    const shared = (await db('nivaro_hub_shared_deployments')
      .whereIn('id', [...sharedIds])
      .select('id', 'version_pin', 'extension_pins')) as Array<Record<string, unknown>>
    for (const s of shared) {
      const on = envs
        .filter((e) => e.kind === 'shared' && Number(e.shared_deployment_id) === Number(s.id))
        .map((e) => Number(e.id))
      for (const envId of on) {
        add(s.version_pin, 'nivaro', envId)
        for (const [id, pin] of Object.entries(strictPinMap(s.extension_pins) ?? {}))
          add(pin, `extension:${id}`, envId)
      }
    }
  }
  return [...byImage.values()].sort((a, b) => a.image.localeCompare(b.image))
}

export interface VulnDeps {
  now?: () => Date
  fetch?: typeof safeFetch
  images?: () => Promise<PinnedImage[]>
  endpoint?: typeof scannerEndpoint
  background?: boolean
}

async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ANSWER_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One image at the scanner. Never throws. */
export async function scanImage(
  endpoint: { url: string; token: string | null },
  image: string,
  deps: VulnDeps = {}
): Promise<{ ok: true; vulns: Vulnerability[] } | { ok: false; code: string }> {
  try {
    const res = await (deps.fetch ?? safeFetch)(`${endpoint.url}/scan`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {})
      },
      body: JSON.stringify({ image }),
      redirect: 'error',
      timeoutMs: SCAN_TIMEOUT_MS
    })
    if (res.status < 200 || res.status >= 300) {
      void res.body?.cancel().catch(() => {})
      return {
        ok: false,
        code: res.status === 401 || res.status === 403 ? 'SCANNER_REFUSED' : `HTTP_${res.status}`
      }
    }
    const text = await readCapped(res)
    if (text === null) return { ok: false, code: 'ANSWER_TOO_BIG' }
    const body = JSON.parse(text) as unknown
    const list = isObj(body) && Array.isArray(body.vulnerabilities) ? body.vulnerabilities : null
    if (!list) return { ok: false, code: 'BAD_ANSWER' }
    const seen = new Set<string>()
    const vulns: Vulnerability[] = []
    for (const v of list.slice(0, 5000)) {
      const x = readVulnerability(v)
      if (!x) continue
      const k = `${x.id}|${x.package}`
      if (seen.has(k)) continue
      seen.add(k)
      vulns.push(x)
    }
    return { ok: true, vulns }
  } catch (err) {
    const name = (err as { name?: unknown } | null)?.name
    return {
      ok: false,
      code: name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'SCANNER_UNREACHABLE'
    }
  }
}

/** Stores one successful scan of an image: upserts its findings, resolves the ones gone. */
export async function storeFindings(
  image: string,
  vulns: Vulnerability[],
  now: Date
): Promise<void> {
  const digest = digestOf(image)
  const existing = (await db(FINDINGS)
    .where({ digest })
    .select('id', 'vuln_id', 'package')) as Array<{
    id: unknown
    vuln_id: string
    package: string
  }>
  const byKey = new Map(existing.map((e) => [`${e.vuln_id}|${e.package}`, Number(e.id)]))
  const keep = new Set<number>()
  for (const v of vulns) {
    const row = {
      image: image.slice(0, 300),
      severity: v.severity,
      installed: v.installed,
      fixed_in: v.fixed,
      url: v.url,
      summary: v.summary,
      last_seen: now,
      resolved_at: null
    }
    const id = byKey.get(`${v.id}|${v.package}`)
    if (id) {
      keep.add(id)
      await db(FINDINGS).where({ id }).update(row)
    } else
      await db(FINDINGS).insert({
        ...row,
        digest,
        vuln_id: v.id,
        package: v.package,
        first_seen: now
      })
  }
  const gone = existing.map((e) => Number(e.id)).filter((id) => !keep.has(id))
  for (let i = 0; i < gone.length; i += 500)
    await db(FINDINGS)
      .whereIn('id', gone.slice(i, i + 500))
      .whereNull('resolved_at')
      .update({ resolved_at: now })
}

export class VulnError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

/** Starts a scan pass (one at a time: 409 SCAN_RUNNING); 409 NO_SCANNER without a URL. */
export async function startScan(
  o: { by: string | null; via: 'person' | 'schedule' },
  deps: VulnDeps = {}
): Promise<number> {
  const now = (deps.now ?? (() => new Date()))()
  const endpoint = await (deps.endpoint ?? scannerEndpoint)()
  if (!endpoint)
    throw new VulnError(409, 'NO_SCANNER', 'Set the scanner endpoint first (Security → Settings).')
  const stale = new Date(now.getTime() - STALE_MS)
  await db(SCANS)
    .where({ status: 'running' })
    .where((w) => w.whereNull('heartbeat_at').orWhere('heartbeat_at', '<', stale))
    .update({
      status: 'failed',
      error: 'The Hub process running this scan stopped.',
      finished_at: now
    })
  const running = await db(SCANS).where({ status: 'running' }).first('id')
  if (running) throw new VulnError(409, 'SCAN_RUNNING', 'A scan is already running.')
  const id = Number(
    await insertReturningId(db, SCANS, {
      status: 'running',
      started_via: o.via,
      started_by: o.by,
      started_at: now,
      heartbeat_at: now
    })
  )
  const run = runScan(id, endpoint, deps)
  if (deps.background === false) await run
  else void run.catch(() => undefined)
  return id
}

async function runScan(
  scanId: number,
  endpoint: { url: string; token: string | null },
  deps: VulnDeps
): Promise<void> {
  const now = deps.now ?? (() => new Date())
  const result: Array<{ image: string; state: 'scanned' | 'error'; code?: string; count: number }> =
    []
  let findings = 0
  try {
    const images = await (deps.images ?? pinnedImages)()
    for (const img of images) {
      await db(SCANS).where({ id: scanId }).update({ heartbeat_at: now() })
      const r = await scanImage(endpoint, img.image, deps)
      if (r.ok) {
        await storeFindings(img.image, r.vulns, now())
        findings += r.vulns.length
        result.push({ image: img.image, state: 'scanned', count: r.vulns.length })
      } else result.push({ image: img.image, state: 'error', code: r.code, count: 0 })
    }
    const failed = result.length > 0 && result.every((r) => r.state === 'error')
    await db(SCANS)
      .where({ id: scanId })
      .update({
        status: failed ? 'failed' : 'done',
        images: result.length,
        findings,
        result: JSON.stringify(result),
        error: failed ? `The scanner answered no image (${result[0]?.code ?? 'error'}).` : null,
        finished_at: now(),
        heartbeat_at: null
      })
  } catch {
    await db(SCANS).where({ id: scanId }).update({
      status: 'failed',
      error: 'The scan stopped on an error.',
      finished_at: now(),
      heartbeat_at: null
    })
  }
}

export interface FindingRow {
  id: number
  image: string
  digest: string
  vuln_id: string
  package: string
  severity: Severity
  installed: string | null
  fixed_in: string | null
  url: string | null
  summary: string | null
  first_seen: string | null
  last_seen: string | null
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

const RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 }

/** Open findings of the given digests, worst first. */
export async function openFindings(digests: string[]): Promise<FindingRow[]> {
  if (!digests.length) return []
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < digests.length; i += 500)
    rows.push(
      ...((await db(FINDINGS)
        .whereIn('digest', digests.slice(i, i + 500))
        .whereNull('resolved_at')
        .select()) as Array<Record<string, unknown>>)
    )
  return rows
    .map((r) => ({
      id: Number(r.id),
      image: String(r.image),
      digest: String(r.digest),
      vuln_id: String(r.vuln_id),
      package: String(r.package),
      severity: String(r.severity) as Severity,
      installed: r.installed == null ? null : String(r.installed),
      fixed_in: r.fixed_in == null ? null : String(r.fixed_in),
      url: r.url == null ? null : String(r.url),
      summary: r.summary == null ? null : String(r.summary),
      first_seen: iso(r.first_seen),
      last_seen: iso(r.last_seen)
    }))
    .sort(
      (a, b) =>
        (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9) ||
        a.vuln_id.localeCompare(b.vuln_id) ||
        a.package.localeCompare(b.package)
    )
}

export async function lastScan(): Promise<Record<string, unknown> | null> {
  const r = (await db(SCANS).orderBy('id', 'desc').first()) as Record<string, unknown> | undefined
  if (!r) return null
  return {
    id: Number(r.id),
    status: String(r.status),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    images: Number(r.images ?? 0),
    findings: Number(r.findings ?? 0),
    error: r.error == null ? null : String(r.error),
    result: (() => {
      try {
        const v = JSON.parse(String(r.result ?? '[]'))
        return Array.isArray(v) ? v : []
      } catch {
        return []
      }
    })()
  }
}

/** Counts per severity. Pure. */
export function severityCounts(rows: Array<{ severity: string }>): Record<Severity, number> {
  const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }
  for (const r of rows)
    c[
      (SEVERITIES as readonly string[]).includes(r.severity) ? (r.severity as Severity) : 'unknown'
    ]++
  return c
}
