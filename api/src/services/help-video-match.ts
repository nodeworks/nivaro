/**
 * Help videos matched to the screen (#18). Pure: which videos a screen gets
 * and in what order, from the screen's keys and the videos' contexts.
 *
 * Tiers, best first:
 *   0 state      the record's collection AND its pipeline state
 *   1 screen     the exact page key (`efp.records.inventory_request`, `admin.jobs.timeline`)
 *   2 pattern    the same screen for any record type (`efp.records.:c`)
 *   3 collection the record type, any state
 *   4 area       the hub / area (`admin.jobs`, `efp.admin`)
 *   5 term       mentions a glossary term shown on the screen
 * Within a tier: role relevance (required for the person's role, then made
 * for their role), then popularity (people who watched it lately), then the
 * newest. Tiers 0–3 are strong: the screen chip offers the best one the
 * person has not finished.
 */

export type MatchTier = 0 | 1 | 2 | 3 | 4 | 5

export const MATCH_REASONS: Record<MatchTier, string> = {
  0: 'This step',
  1: 'This screen',
  2: 'Screens like this one',
  3: 'This record type',
  4: 'This area',
  5: 'Mentions a term on this screen'
}

/** A chip is offered for tiers up to this one. */
export const STRONG_TIER: MatchTier = 3

export interface ScreenKeys {
  exact: string[]
  patterns: string[]
  areas: string[]
  collection: string | null
  item: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_RE = /^[A-Za-z0-9_.:-]{1,100}$/
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
/** Path segments followed by a collection name. */
const COLLECTION_PARENTS = new Set(['collections', 'records', 'data-model'])

/** A segment that names one record, not a screen (efp-new's help-video-page rule). */
export function isIdSegment(s: string): boolean {
  if (/^\d+$/.test(s) || UUID.test(s)) return true
  if (!/\d{3,}/.test(s)) return false
  const alnum = s.replace(/[^A-Za-z0-9]/g, '')
  const digits = alnum.replace(/\D/g, '')
  return digits.length * 2 >= alnum.length
}

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_:-]/g, '-')
const valid = (k: string) => KEY_RE.test(k)

/**
 * The keys a screen answers to. `page` is the host's own page key (efp-new
 * sends one); `path` is the route (`/collections/purchase_orders/12`), turned
 * into `<app>.<segments>` with record ids dropped — the same rule efp-new's
 * page keys follow — so an author's page context matches either way.
 */
export function screenKeys(q: {
  page?: string | null
  path?: string | null
  collection?: string | null
  item?: string | null
  app?: string | null
}): ScreenKeys {
  const exact = new Set<string>()
  const patterns = new Set<string>()
  const areas = new Set<string>()
  let collection = q.collection && IDENT.test(q.collection) ? q.collection : null
  let item = q.item ? String(q.item).slice(0, 100) : null

  const fromSegments = (app: string, segs: string[], rawSegs: string[]) => {
    const key = `${app}.${segs.length ? segs.join('.') : 'home'}`.slice(0, 100)
    if (valid(key)) exact.add(key)
    const pat = segs.map((s, i) =>
      (i > 0 && COLLECTION_PARENTS.has(segs[i - 1])) ||
      (collection && s === collection.toLowerCase())
        ? ':c'
        : s
    )
    const patKey = `${app}.${pat.join('.')}`.slice(0, 100)
    if (patKey !== key && valid(patKey)) patterns.add(patKey)
    if (segs.length >= 1) {
      const area = `${app}.${segs[0]}`
      if (area !== key && valid(area)) areas.add(area)
    }
    // /collections/:c/:id — the collection, and the record when it is one.
    for (let i = 0; i < rawSegs.length - 1; i++) {
      if (!COLLECTION_PARENTS.has(rawSegs[i].toLowerCase())) continue
      const c = rawSegs[i + 1]
      if (!collection && IDENT.test(c)) collection = c
      const next = rawSegs[i + 2]
      if (!item && next && next !== 'new' && isIdSegment(next)) item = next
      break
    }
  }

  if (q.page && valid(q.page)) {
    const segs = q.page.split('.').filter(Boolean)
    exact.add(q.page)
    if (segs.length >= 2) {
      const [app, ...rest] = segs
      const pat = rest.map((s, i) =>
        (i > 0 && COLLECTION_PARENTS.has(rest[i - 1])) ||
        (collection && s === collection.toLowerCase())
          ? ':c'
          : s
      )
      const patKey = [app, ...pat].join('.')
      if (patKey !== q.page && valid(patKey)) patterns.add(patKey)
      if (rest.length >= 2) areas.add(`${app}.${rest[0]}`)
      // efp.records.<collection> — a record list names its collection.
      for (let i = 0; i < rest.length - 1; i++) {
        if (COLLECTION_PARENTS.has(rest[i]) && !collection && IDENT.test(rest[i + 1])) {
          collection = rest[i + 1]
          break
        }
      }
    }
  }
  if (q.path) {
    const path = String(q.path).split(/[?#]/)[0] ?? ''
    let raw: string[]
    try {
      raw = path
        .split('/')
        .filter(Boolean)
        .map((s) => decodeURIComponent(s))
    } catch {
      raw = []
    }
    const rawKept = raw.filter((s) => !isIdSegment(s))
    const app = q.app && /^[a-z][a-z0-9-]{0,19}$/.test(q.app) ? q.app : 'admin'
    // Collection detection reads the raw segments (ids included).
    fromSegments(app, rawKept.map(clean).filter(Boolean), raw)
  }
  for (const k of exact) {
    patterns.delete(k)
    areas.delete(k)
  }
  for (const k of patterns) areas.delete(k)
  return { exact: [...exact], patterns: [...patterns], areas: [...areas], collection, item }
}

export interface ContextRow {
  video_id: string
  kind: string
  key: string
  state_key: string | null
}

export interface VideoFacts {
  id: string
  title: string
  description?: string | null
  category?: string | null
  /** Required for the person's role. */
  required: boolean
  /** Visibility names the person's role (made for them, not for everyone). */
  forMyRole: boolean
  /** People who watched it lately. */
  viewers: number
  /** ms since epoch; the newest wins a tie. */
  updatedAt: number
}

export interface ScreenMatch {
  id: string
  tier: MatchTier
  reason: string
  term?: string
}

/** Whether a video's title / description / category mentions a term (whole
 *  words, case-insensitive). Returns the term it matched. */
export function mentionedTerm(
  v: Pick<VideoFacts, 'title' | 'description' | 'category'>,
  terms: string[]
): string | null {
  const text = ` ${[v.title, v.description ?? '', v.category ?? ''].join(' ').toLowerCase()} `
  for (const t of terms) {
    const term = t.trim().toLowerCase()
    if (term.length < 2) continue
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc}s?([^\\p{L}\\p{N}]|$)`, 'u').test(text))
      return t.trim()
  }
  return null
}

const low = (v: unknown) => String(v ?? '').toLowerCase()

/** Rank every candidate video for the screen (best first, each once). */
export function rankScreenVideos(
  rows: ContextRow[],
  keys: ScreenKeys,
  ctx: { state?: string | null; terms?: string[] },
  facts: Map<string, VideoFacts>
): ScreenMatch[] {
  const exact = new Set(keys.exact.map(low))
  const patterns = new Set(keys.patterns.map(low))
  const areas = keys.areas.map(low)
  const col = keys.collection ? low(keys.collection) : null
  const best = new Map<string, ScreenMatch>()
  const offer = (id: string, tier: MatchTier, term?: string) => {
    const k = low(id)
    const prev = best.get(k)
    if (!prev || tier < prev.tier)
      best.set(k, {
        id,
        tier,
        reason: term ? `Mentions ${term}` : MATCH_REASONS[tier],
        ...(term ? { term } : {})
      })
  }
  for (const r of rows) {
    const key = low(r.key)
    if (r.kind === 'collection' && col && key === col) {
      if (r.state_key) {
        if (ctx.state && low(r.state_key) === low(ctx.state)) offer(r.video_id, 0)
      } else offer(r.video_id, 3)
    } else if (r.kind === 'page') {
      if (exact.has(key)) offer(r.video_id, 1)
      else if (patterns.has(key)) offer(r.video_id, 2)
      else if (areas.some((a) => key === a || key.startsWith(`${a}.`))) offer(r.video_id, 4)
    }
  }
  const terms = (ctx.terms ?? []).filter((t) => t.trim().length >= 2)
  if (terms.length) {
    for (const f of facts.values()) {
      if (best.has(low(f.id))) continue
      const term = mentionedTerm(f, terms)
      if (term) offer(f.id, 5, term)
    }
  }
  const role = (f: VideoFacts | undefined) => (f?.required ? 2 : f?.forMyRole ? 1 : 0)
  return [...best.values()]
    .filter((m) => facts.has(low(m.id)))
    .sort((a, b) => {
      const fa = facts.get(low(a.id))
      const fb = facts.get(low(b.id))
      return (
        a.tier - b.tier ||
        role(fb) - role(fa) ||
        (fb?.viewers ?? 0) - (fa?.viewers ?? 0) ||
        (fb?.updatedAt ?? 0) - (fa?.updatedAt ?? 0) ||
        String(fa?.title ?? '').localeCompare(String(fb?.title ?? ''))
      )
    })
}

/** The chip's video: the best strong match the person has not finished and
 *  can watch now. */
export function bestUnwatched(
  ranked: ScreenMatch[],
  watch: (id: string) => { completed: boolean; ready: boolean } | undefined
): ScreenMatch | null {
  for (const m of ranked) {
    if (m.tier > STRONG_TIER) break
    const w = watch(m.id)
    if (w && !w.completed && w.ready) return m
  }
  return null
}
