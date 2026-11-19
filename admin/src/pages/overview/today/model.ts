import { SLOT_KINDS, type SlotFilters, type SlotKind } from './slot-model'

/**
 * The Overview "Today" drill sheet's place, kept in the URL (`?today=…&td_…`) so every depth
 * is a link: the figure (records / people / jobs / issues / one timeline slot), then a person,
 * a record, a job run or an issue, then one activity entry. Pure — tested in model.test.ts.
 */

export type TodayKind = 'records' | 'people' | 'jobs' | 'issues' | 'slot'
export const TODAY_KINDS: TodayKind[] = ['records', 'people', 'jobs', 'issues', 'slot']

export interface TodayDrill {
  kind: TodayKind
  /** Records sheet: one row per record, or every change. */
  tab?: 'records' | 'changes'
  /** Records sheet: narrowed to one collection / one person (from the breakdown). */
  col?: string
  who?: string
  /** A record's changes today. */
  rec?: { collection: string; item: string }
  /** A person's activity today. */
  person?: string
  run?: number
  issue?: number
  /** A timeline slot's start. */
  at?: string
  /** A timeline slot's list: search, kinds, outcome, job, sort, view (`td_q`, `td_k`, `td_o`,
   *  `td_src`, `td_sort`, `td_v`; the person is `who`). Kept while drilling, so Back returns
   *  to the same narrowed list. */
  slot?: Omit<SlotFilters, 'who'>
  /** One activity entry, to the last leaf. */
  entry?: number
}

const KEYS = [
  'today',
  'td_tab',
  'td_col',
  'td_who',
  'td_rec',
  'td_person',
  'td_run',
  'td_issue',
  'td_at',
  'td_entry',
  'td_q',
  'td_k',
  'td_o',
  'td_src',
  'td_sort',
  'td_v'
]
const JOB_ID = /^[A-Za-z0-9_:.-]{1,128}$/
const OUTCOMES = ['failed', 'slow', 'ok'] as const
const SORTS = ['new', 'old', 'long', 'kind', 'count'] as const

function parseSlotFilters(p: URLSearchParams): TodayDrill['slot'] {
  const f: NonNullable<TodayDrill['slot']> = {}
  const q = p.get('td_q')?.slice(0, 120)
  if (q?.trim()) f.q = q
  const kinds = (p.get('td_k') ?? '')
    .split(',')
    .filter((k): k is SlotKind => (SLOT_KINDS as string[]).includes(k))
  if (kinds.length) f.kinds = [...new Set(kinds)]
  const o = p.get('td_o')
  if (o && (OUTCOMES as readonly string[]).includes(o)) f.outcome = o as SlotFilters['outcome']
  const src = p.get('td_src')
  if (src && JOB_ID.test(src)) f.src = src
  const sort = p.get('td_sort')
  if (sort && sort !== 'new' && (SORTS as readonly string[]).includes(sort))
    f.sort = sort as SlotFilters['sort']
  if (p.get('td_v') === 'all') f.view = 'all'
  return Object.keys(f).length ? f : undefined
}

function writeSlotFilters(out: URLSearchParams, f: TodayDrill['slot']): void {
  if (!f) return
  if (f.q?.trim()) out.set('td_q', f.q)
  if (f.kinds?.length) out.set('td_k', f.kinds.join(','))
  if (f.outcome) out.set('td_o', f.outcome)
  if (f.src) out.set('td_src', f.src)
  if (f.sort && f.sort !== 'new') out.set('td_sort', f.sort)
  if (f.view === 'all') out.set('td_v', 'all')
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLLECTION = /^[A-Za-z0-9_]{1,64}$/

const posInt = (v: string | null) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function parseTodayDrill(p: URLSearchParams): TodayDrill | null {
  const kind = p.get('today') as TodayKind | null
  if (!kind || !TODAY_KINDS.includes(kind)) return null
  const d: TodayDrill = { kind }
  const tab = p.get('td_tab')
  if (kind === 'records' && (tab === 'records' || tab === 'changes')) d.tab = tab
  const col = p.get('td_col')
  if (col && COLLECTION.test(col)) d.col = col
  const who = p.get('td_who')
  if (who && UUID.test(who)) d.who = who
  const rec = p.get('td_rec')
  const m = rec ? /^([A-Za-z0-9_]{1,64}):(.{1,255})$/.exec(rec) : null
  if (m) d.rec = { collection: m[1], item: m[2] }
  const person = p.get('td_person')
  if (person && UUID.test(person)) d.person = person
  d.run = posInt(p.get('td_run'))
  d.issue = posInt(p.get('td_issue'))
  const at = p.get('td_at')
  if (at && !Number.isNaN(new Date(at).getTime())) d.at = at
  d.entry = posInt(p.get('td_entry'))
  if (kind === 'slot') d.slot = parseSlotFilters(p)
  for (const k of Object.keys(d) as Array<keyof TodayDrill>) if (d[k] === undefined) delete d[k]
  return d
}

/** Write a drill into params (clearing every other td_ key, keeping the page's own params). */
export function withTodayDrill(p: URLSearchParams, d: TodayDrill | null): URLSearchParams {
  const out = new URLSearchParams(p)
  for (const k of KEYS) out.delete(k)
  if (!d) return out
  out.set('today', d.kind)
  if (d.tab) out.set('td_tab', d.tab)
  if (d.col) out.set('td_col', d.col)
  if (d.who) out.set('td_who', d.who)
  if (d.rec) out.set('td_rec', `${d.rec.collection}:${d.rec.item}`)
  if (d.person) out.set('td_person', d.person)
  if (d.run) out.set('td_run', String(d.run))
  if (d.issue) out.set('td_issue', String(d.issue))
  if (d.at) out.set('td_at', d.at)
  if (d.entry) out.set('td_entry', String(d.entry))
  if (d.kind === 'slot') writeSlotFilters(out, d.slot)
  return out
}

export type TodayLevel = 'root' | 'person' | 'record' | 'run' | 'issue' | 'entry'

/** The levels from the figure down to where the sheet is (the breadcrumb trail). */
export function todayLevels(d: TodayDrill): TodayLevel[] {
  const out: TodayLevel[] = ['root']
  if (d.person) out.push('person')
  if (d.rec) out.push('record')
  if (d.run) out.push('run')
  if (d.issue) out.push('issue')
  if (d.entry) out.push('entry')
  return out
}

/** One level up (Back): the deepest step removed. */
export function upOne(d: TodayDrill): TodayDrill | null {
  const levels = todayLevels(d)
  const last = levels[levels.length - 1]
  if (last === 'root') return null
  return toLevel(d, levels[levels.length - 2])
}

/** The drill cut back to `level` (a breadcrumb press). */
export function toLevel(d: TodayDrill, level: TodayLevel): TodayDrill {
  const levels = todayLevels(d)
  const keep = levels.slice(0, levels.indexOf(level) + 1)
  const out: TodayDrill = { kind: d.kind }
  if (d.tab) out.tab = d.tab
  if (d.col) out.col = d.col
  if (d.who) out.who = d.who
  if (d.at) out.at = d.at
  if (d.slot) out.slot = d.slot
  if (keep.includes('person')) out.person = d.person
  if (keep.includes('record')) out.rec = d.rec
  if (keep.includes('run')) out.run = d.run
  if (keep.includes('issue')) out.issue = d.issue
  if (keep.includes('entry')) out.entry = d.entry
  return out
}

export const ROOT_TITLES: Record<TodayKind, string> = {
  records: 'Records changed today',
  people: 'People active today',
  jobs: 'Failed jobs, 24 h',
  issues: 'Open issues',
  slot: 'Today on this instance'
}

export const FIGURE_KIND: Record<string, TodayKind> = {
  records_changed: 'records',
  people_active: 'people',
  failed_jobs: 'jobs',
  open_issues: 'issues'
}

export type PeopleSort = 'name' | 'role' | 'first' | 'last' | 'actions' | 'changed' | 'opened'

export interface PersonRow {
  id: string
  /** A name, or what the account is ("Deleted user", "Redacted person"). */
  name: string | null
  kind?: 'person' | 'deleted' | 'redacted' | 'placeholder' | 'machine' | 'unnamed'
  email: string | null
  role: string | null
  status: string | null
  first_at: string
  last_at: string
  actions: number
  writes: number
  records_changed: number
  records_opened: number
}

/** The people list's sort + text filter (pure). */
export function sortPeople(
  rows: PersonRow[],
  sort: PeopleSort,
  dir: 'asc' | 'desc',
  q = '',
  role: string | null = null
): PersonRow[] {
  const needle = q.trim().toLowerCase()
  const val = (r: PersonRow): string | number => {
    switch (sort) {
      case 'name':
        return (r.name ?? r.email ?? '').toLowerCase()
      case 'role':
        return (r.role ?? '').toLowerCase()
      case 'first':
        return r.first_at
      case 'last':
        return r.last_at
      case 'actions':
        return r.actions
      case 'changed':
        return r.records_changed
      case 'opened':
        return r.records_opened
    }
  }
  const out = rows.filter(
    (r) =>
      (!needle ||
        (r.name ?? '').toLowerCase().includes(needle) ||
        (r.email ?? '').toLowerCase().includes(needle) ||
        (r.role ?? '').toLowerCase().includes(needle)) &&
      (!role || r.role === role)
  )
  return out.sort((a, b) => {
    const x = val(a)
    const y = val(b)
    const c = x < y ? -1 : x > y ? 1 : 0
    return dir === 'asc' ? c : -c
  })
}

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/**
 * The window a Today sheet counts, in words — the SAME window as its figure: from the viewer's
 * midnight ("today since 12:00 AM, your time") to when the figure was worked out. First and last
 * seen are inside it. Pure.
 */
export function windowSubtitle(from: string, to: string, now = new Date()): string {
  const a = new Date(from)
  const b = new Date(to)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 'today'
  const midnight = a.getHours() === 0 && a.getMinutes() === 0
  const sameDay = a.toDateString() === now.toDateString()
  if (midnight && sameDay) return `today since ${clock(a)} your time, up to ${clock(b)}`
  return `from ${a.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} up to ${clock(b)}`
}
