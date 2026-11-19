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
  'td_entry'
]
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
  name: string | null
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
