/**
 * The Overview timeline slot sheet ("8:18 AM on this instance"), pure: readable job names,
 * which runs were slow, folding identical routine runs into one line, the "Needs a look" list,
 * filters and sorts. Tested in slot-model.test.ts.
 */

export type SlotKind = 'job' | 'deploy' | 'import' | 'config'
export const SLOT_KINDS: SlotKind[] = ['job', 'config', 'import', 'deploy']

export interface SlotMark {
  at: string
  kind: SlotKind
  failed: boolean
  sentence: string
  href: string
  run_id?: number
  activity_id?: number
  job_id?: string
  job_label?: string
  run_kind?: string
  extension?: string
  description?: string
  duration_ms?: number
  error?: string
  manual?: boolean
  user?: string
  user_name?: string
  collection?: string
}

export type SlotOutcome = 'failed' | 'slow' | 'ok'
export type SlotSort = 'new' | 'old' | 'long' | 'kind' | 'count'
export type SlotView = 'grouped' | 'all'

export interface SlotFilters {
  q?: string
  kinds?: SlotKind[]
  outcome?: SlotOutcome
  /** One job (its job id). */
  src?: string
  /** One person (user id). */
  who?: string
  sort?: SlotSort
  view?: SlotView
}

export const KIND_LABEL: Record<SlotKind, { one: string; many: string }> = {
  job: { one: 'Job', many: 'Jobs' },
  config: { one: 'Config', many: 'Config changes' },
  import: { one: 'Import', many: 'Imports' },
  deploy: { one: 'Deploy', many: 'Deploys' }
}

// ─── Names ───────────────────────────────────────────────────────────────────

const EXT_RE = /^ext:([^:]+):/

/** `ext:acme:sync-orders` → `acme`. */
export function extensionOf(jobId: string | undefined): string | undefined {
  return jobId ? (EXT_RE.exec(jobId)?.[1] ?? undefined) : undefined
}

const ACRONYMS = new Set([
  'ai',
  'api',
  'csv',
  'erp',
  'etl',
  'id',
  'kpi',
  'json',
  'mcp',
  'oidc',
  'pdf',
  'sla',
  'sms',
  'sql',
  'sso',
  'ui',
  'url',
  'xml'
])

function wordCase(w: string, i: number): string {
  // A short word with no vowel is an abbreviation (mwf, crm, rss): say it in capitals.
  if (ACRONYMS.has(w) || (w.length >= 2 && w.length <= 4 && !/[aeiouy]/.test(w)))
    return w.toUpperCase()
  return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w
}

/** Words from a machine name: `staged-imports` → `Staged imports`, `ssl_cert` → `SSL cert`. */
function sayId(id: string): string {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  const out: string[] = []
  // A uuid inside an id reads as its first eight characters.
  for (const token of id.replace(UUID, (u) => u.slice(0, 8).toUpperCase()).split(/[-_.:/\s]+/)) {
    if (!token) continue
    if (/^[0-9A-F]{6,}$/.test(token) && /\d/.test(token)) {
      out.push(token)
      continue
    }
    for (const w of token
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(' '))
      if (w) out.push(wordCase(w, out.length))
  }
  return out.join(' ')
}

/** `ssl_cert:EFP Production API` — a check kind, then a name a person gave it. */
const NAMED_RE = /^([a-z][a-z0-9_-]*):(.+)$/
const HEXISH_RE = /^[0-9a-f-]{8,}$/i

function namedPart(id: string): { kind: string; name: string } | null {
  if (EXT_RE.test(id)) return null
  const m = NAMED_RE.exec(id)
  if (!m) return null
  const name = m[2].trim()
  // A person's name has a space or capitals; an id tail (a uuid, a number) does not.
  if (!name || HEXISH_RE.test(name) || !/[\sA-Z]/.test(name)) return null
  return { kind: m[1], name }
}

/**
 * A job in words: its own label when it says more than the id, else the id read aloud —
 * `staged-imports` → `Staged imports`, `ext:acme:auto-create-mwf` → `Auto create MWF`,
 * `ssl_cert:EFP Production API` → `EFP Production API`. Where it comes from (the extension, the
 * check kind) is shown beside it by `jobTag`, never folded into the name.
 */
export function readableJobName(jobId: string | undefined, label?: string | null): string {
  const id = String(jobId ?? '').trim()
  const own = String(label ?? '').trim()
  if (own && own !== id && own !== id.replace(EXT_RE, '')) return own
  const named = namedPart(id)
  if (named) return named.name
  return sayId(id.replace(EXT_RE, '')) || id || 'A job'
}

/** The small tag beside a job's name: its extension, or the kind of check it is. */
export function jobTag(
  jobId: string | undefined,
  extension?: string
): { text: string; tip: string } | undefined {
  const ext = extension ?? extensionOf(jobId)
  if (ext) return { text: ext, tip: `Registered by the ${ext} extension` }
  const named = jobId ? namedPart(jobId) : null
  if (named) {
    const kind = sayId(named.kind)
    return { text: kind, tip: `Check type: ${kind}` }
  }
  return undefined
}

/** What a row is called: a job's name, else the strip's own sentence. */
export function markTitle(m: SlotMark): string {
  if (m.kind === 'job' && m.job_id) return readableJobName(m.job_id, m.job_label)
  return m.sentence
}

/** Identical routine events share a key: one job's runs, or the very same sentence. */
export function groupKeyOf(m: SlotMark): string {
  return m.kind === 'job' && m.job_id ? `job:${m.job_id}` : `${m.kind}:${m.sentence}`
}

// ─── Words for numbers ───────────────────────────────────────────────────────

export function durationWords(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  return `${(ms / 3_600_000).toFixed(1)} h`
}

/** How often a folded job ran: `every ~10 s`. */
export function cadenceWords(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `every ~${s} s`
  const min = Math.round(ms / 60_000)
  if (min < 60) return `every ~${min} min`
  return `every ~${Math.round(ms / 3_600_000)} h`
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ─── Slow ────────────────────────────────────────────────────────────────────

/** A run this long is slow whatever its job usually takes. */
export const SLOW_ALWAYS_MS = 60_000
/** Never call a run slow under this, however quick its job usually is. */
export const SLOW_FLOOR_MS = 5_000

/**
 * The runs that took far longer than their job usually does in this slot: at least 3× the
 * job's median (and over 5 s) once it ran 4+ times, or over a minute whatever the job.
 * Returns run ids.
 */
export function slowRunIds(marks: SlotMark[]): Set<number> {
  const byJob = new Map<string, number[]>()
  for (const m of marks)
    if (m.kind === 'job' && m.job_id && m.duration_ms != null)
      byJob.set(m.job_id, [...(byJob.get(m.job_id) ?? []), m.duration_ms])
  const out = new Set<number>()
  for (const m of marks) {
    if (m.kind !== 'job' || m.run_id == null || m.duration_ms == null || m.failed) continue
    const ds = byJob.get(m.job_id ?? '') ?? []
    const med = ds.length >= 4 ? median(ds) : null
    const slow =
      m.duration_ms >= SLOW_ALWAYS_MS ||
      (med != null && m.duration_ms >= SLOW_FLOOR_MS && m.duration_ms >= 3 * med)
    if (slow) out.add(m.run_id)
  }
  return out
}

export function outcomeOf(m: SlotMark, slow: Set<number>): SlotOutcome {
  if (m.failed) return 'failed'
  if (m.run_id != null && slow.has(m.run_id)) return 'slow'
  return 'ok'
}

// ─── Filter + sort ───────────────────────────────────────────────────────────

export function matchesText(m: SlotMark, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return [
    markTitle(m),
    m.sentence,
    m.job_id,
    m.extension,
    m.error,
    m.user_name,
    m.description,
    m.collection
  ].some((v) => !!v && v.toLowerCase().includes(needle))
}

export function filterSlotMarks(marks: SlotMark[], f: SlotFilters, slow: Set<number>): SlotMark[] {
  return marks.filter(
    (m) =>
      (!f.kinds?.length || f.kinds.includes(m.kind)) &&
      (!f.outcome || outcomeOf(m, slow) === f.outcome) &&
      (!f.src || m.job_id === f.src) &&
      (!f.who || (m.user ?? '').toLowerCase() === f.who.toLowerCase()) &&
      (!f.q || matchesText(m, f.q))
  )
}

const KIND_ORDER: Record<SlotKind, number> = { job: 0, config: 1, import: 2, deploy: 3 }

export function sortSlotMarks(marks: SlotMark[], sort: SlotSort = 'new'): SlotMark[] {
  const at = (m: SlotMark) => new Date(m.at).getTime()
  return [...marks].sort((a, b) => {
    switch (sort) {
      case 'old':
        return at(a) - at(b)
      case 'long':
        return (b.duration_ms ?? -1) - (a.duration_ms ?? -1) || at(b) - at(a)
      case 'kind':
        return (
          KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
          markTitle(a).localeCompare(markTitle(b)) ||
          at(b) - at(a)
        )
      default:
        return at(b) - at(a)
    }
  })
}

// ─── Fold ────────────────────────────────────────────────────────────────────

export interface SlotGroup {
  key: string
  kind: SlotKind
  title: string
  extension?: string
  description?: string
  job_id?: string
  /** Newest first. */
  marks: SlotMark[]
  count: number
  failed: number
  slow: number
  first_at: string
  last_at: string
  median_ms: number | null
  max_ms: number | null
  /** The usual gap between runs (3+ runs). */
  cadence_ms: number | null
}

export function groupSlotMarks(marks: SlotMark[], slow: Set<number>): SlotGroup[] {
  const by = new Map<string, SlotMark[]>()
  for (const m of marks) {
    const k = groupKeyOf(m)
    const list = by.get(k)
    if (list) list.push(m)
    else by.set(k, [m])
  }
  return [...by.entries()].map(([key, list]) => {
    const ms = [...list].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    const times = ms.map((m) => new Date(m.at).getTime()).sort((a, b) => a - b)
    const gaps = times.slice(1).map((t, i) => t - times[i])
    const ds = ms.map((m) => m.duration_ms).filter((d): d is number => d != null)
    const head = ms[0]
    return {
      key,
      kind: head.kind,
      title: markTitle(head),
      extension: head.extension ?? extensionOf(head.job_id),
      description: ms.find((m) => m.description)?.description,
      job_id: head.job_id,
      marks: ms,
      count: ms.length,
      failed: ms.filter((m) => m.failed).length,
      slow: ms.filter((m) => outcomeOf(m, slow) === 'slow').length,
      first_at: ms[ms.length - 1].at,
      last_at: head.at,
      median_ms: median(ds),
      max_ms: ds.length ? Math.max(...ds) : null,
      cadence_ms: ms.length >= 3 ? median(gaps) : null
    }
  })
}

export function sortGroups(groups: SlotGroup[], sort: SlotSort = 'new'): SlotGroup[] {
  const t = (iso: string) => new Date(iso).getTime()
  return [...groups].sort((a, b) => {
    // Trouble always floats up inside any order.
    const trouble = Number(b.failed > 0) - Number(a.failed > 0)
    if (trouble) return trouble
    switch (sort) {
      case 'old':
        return t(a.first_at) - t(b.first_at)
      case 'long':
        return (b.max_ms ?? -1) - (a.max_ms ?? -1) || b.count - a.count
      case 'kind':
        return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.title.localeCompare(b.title)
      case 'count':
        return b.count - a.count || t(b.last_at) - t(a.last_at)
      default:
        return t(b.last_at) - t(a.last_at)
    }
  })
}

/** `all succeeded` · `1 failed` · `2 failed · 1 slow` · `1 slow`. */
export function outcomeWords(g: Pick<SlotGroup, 'count' | 'failed' | 'slow' | 'kind'>): string {
  const parts: string[] = []
  if (g.failed) parts.push(`${g.failed} failed`)
  if (g.slow) parts.push(`${g.slow} slow`)
  if (parts.length) return parts.join(' · ')
  if (g.kind !== 'job' && g.kind !== 'import') return g.count === 1 ? 'done' : 'all done'
  return g.count === 1 ? 'succeeded' : 'all succeeded'
}

// ─── Needs a look ────────────────────────────────────────────────────────────

export interface LookItem {
  key: string
  tone: 'failed' | 'slow'
  title: string
  extension?: string
  job_id?: string
  count: number
  /** The newest of them: what the row opens. */
  latest: SlotMark
  error?: string
  /** Slow: the longest run, and what the job usually takes in the slot. */
  longest_ms?: number
  usual_ms?: number | null
}

/** Failures first, then slow runs — one line per job (a job failing every run is one problem). */
export function needsALook(marks: SlotMark[], slow: Set<number>): LookItem[] {
  const groups = groupSlotMarks(marks, slow)
  const out: LookItem[] = []
  for (const g of groups) {
    const failed = g.marks.filter((m) => m.failed)
    if (failed.length)
      out.push({
        key: `failed:${g.key}`,
        tone: 'failed',
        title: g.title,
        extension: g.extension,
        job_id: g.job_id,
        count: failed.length,
        latest: failed[0],
        error: failed.find((m) => m.error)?.error
      })
    const slowOnes = g.marks.filter((m) => outcomeOf(m, slow) === 'slow')
    if (slowOnes.length) {
      const longest = slowOnes.reduce((a, b) =>
        (b.duration_ms ?? 0) > (a.duration_ms ?? 0) ? b : a
      )
      out.push({
        key: `slow:${g.key}`,
        tone: 'slow',
        title: g.title,
        extension: g.extension,
        job_id: g.job_id,
        count: slowOnes.length,
        latest: longest,
        longest_ms: longest.duration_ms,
        usual_ms: g.median_ms
      })
    }
  }
  return out.sort(
    (a, b) =>
      Number(b.tone === 'failed') - Number(a.tone === 'failed') ||
      (a.latest.at < b.latest.at ? 1 : a.latest.at > b.latest.at ? -1 : 0)
  )
}

export function kindCounts(marks: SlotMark[]): Record<SlotKind, number> {
  const out: Record<SlotKind, number> = { job: 0, config: 0, import: 0, deploy: 0 }
  for (const m of marks) out[m.kind] = (out[m.kind] ?? 0) + 1
  return out
}

/** The people in the slot (manual runs, config changes), most active first. */
export function slotPeople(marks: SlotMark[]): Array<{ id: string; name: string; count: number }> {
  const by = new Map<string, { id: string; name: string; count: number }>()
  for (const m of marks) {
    if (!m.user) continue
    const k = m.user.toLowerCase()
    const cur = by.get(k) ?? { id: m.user, name: m.user_name ?? 'Someone', count: 0 }
    cur.count++
    by.set(k, cur)
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** The jobs in the slot for the Job filter, most runs first. */
export function slotJobs(marks: SlotMark[]): Array<{ id: string; name: string; count: number }> {
  const by = new Map<string, { id: string; name: string; count: number }>()
  for (const m of marks) {
    if (m.kind !== 'job' || !m.job_id) continue
    const cur = by.get(m.job_id) ?? {
      id: m.job_id,
      name: readableJobName(m.job_id, m.job_label),
      count: 0
    }
    cur.count++
    by.set(m.job_id, cur)
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** True when any filter narrows the list (sort and view do not). */
export function isFiltered(f: SlotFilters): boolean {
  return !!(f.q?.trim() || f.kinds?.length || f.outcome || f.src || f.who)
}
