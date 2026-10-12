import { db } from '../db/index.js'
import type { User } from '../types.js'
import { scrubText } from './ai-explain.js'
import { can } from './permissions.js'

/**
 * Ask AI panel helpers (w2 ai-panel): follow-up questions (#1834), slash-command
 * answer formats (#1884), starter questions per page (#1887), the saved-view
 * visibility query (#1942) and link-label lookup shared by the choice, compare
 * and drill paths. Everything here is pure or reads as the asker; none of it
 * calls the model.
 */

// ── Follow-up questions (#1834) ──────────────────────────────────────────────

const FOLLOWUPS_BLOCK = /\n*```followups\s*\n([\s\S]*?)```\s*$/i
const MAX_FOLLOWUPS = 3
const MAX_FOLLOWUP_LEN = 120

/**
 * Split the trailing ```followups block the model was asked to end with off
 * the answer. The twin lives in packages/shared (lib/ai-followups.ts) for the
 * streaming view — keep the two in step. A block that does not parse is
 * dropped from the text all the same: it is never shown as an answer.
 */
export function extractFollowUps(text: string): { text: string; followups: string[] } {
  const m = FOLLOWUPS_BLOCK.exec(text)
  if (!m) return { text, followups: [] }
  const body = text.slice(0, m.index).trimEnd()
  let list: unknown = null
  try {
    list = JSON.parse(m[1].trim())
  } catch {
    list = null
  }
  if (!Array.isArray(list)) return { text: body, followups: [] }
  const seen = new Set<string>()
  const followups: string[] = []
  for (const q of list) {
    if (typeof q !== 'string') continue
    const s = scrubText(q.replace(/\s+/g, ' ').trim()).slice(0, MAX_FOLLOWUP_LEN)
    if (s.length < 3 || seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    followups.push(s)
    if (followups.length >= MAX_FOLLOWUPS) break
  }
  return { text: body, followups }
}

/**
 * When the model left the block out: questions from the SHAPE of what the
 * tools returned (never their values), so a click is still one step away.
 */
export function fallbackFollowUps(
  trace: Array<{ tool: string; input: Record<string, unknown>; summary: string }>
): string[] {
  const ok = trace.filter((t) => !t.summary?.startsWith('error:'))
  const last = [...ok].reverse().find((t) => t.tool === 'aggregate' || t.tool === 'query_items')
  if (!last) return []
  const col =
    typeof last.input.collection === 'string' ? last.input.collection.replace(/_/g, ' ') : 'these'
  if (last.tool === 'aggregate' && last.input.group_by) {
    return [`Show that as a chart`, `Which ${col} changed most in the last 30 days?`]
  }
  if (last.tool === 'aggregate') {
    return [`Break that down by state`, `How does that compare with last month?`]
  }
  return [`How many of these ${col} were created in the last 30 days?`, `Group these by state`]
}

// ── Slash commands (#1884) ───────────────────────────────────────────────────

export type AnswerCommand = 'chart' | 'table' | 'explain' | 'steps'

export const ANSWER_COMMANDS = new Set<string>(['chart', 'table', 'explain', 'steps'])

const COMMAND_DIRECTIVES: Record<AnswerCommand, string> = {
  chart:
    'Format: answer with a chart. After one lead sentence, include the fenced "chart" block (bar, line or pie as fits) from the numbers the tools return. If the answer is not a series of numbers, say so in one sentence.',
  table:
    'Format: answer as a markdown table (at most 3 columns where you can; one row per line) after one lead sentence, instead of prose or bullets.',
  explain:
    'Format: explain how the previous answer was reached — which collections and filters were read, how the figure was computed, and any caveat about access limits or data quality. Re-use the earlier results; call a tool only if you need one fact you do not have.',
  steps:
    'Format: answer as a short numbered list of steps (maximum 8), one action per step, each a single line.'
}

export function parseAnswerCommand(v: unknown): AnswerCommand | null {
  return typeof v === 'string' && ANSWER_COMMANDS.has(v) ? (v as AnswerCommand) : null
}

/** The line appended to the newest question for a slash command (not stored with the question). */
export function commandDirective(cmd: AnswerCommand): string {
  return `\n\n[${COMMAND_DIRECTIVES[cmd]}]`
}

// ── Starter questions per page (#1887) ───────────────────────────────────────

export interface Starter {
  question: string
  source: 'page' | 'guide'
}

export type PageKind = 'record' | 'list' | 'queue' | 'report' | 'dashboard' | 'home'

/** Which kind of screen a normalised page pattern (x-nivaro-page style) is. */
export function pageKindOf(page: string): PageKind {
  const segs = page.split(/[?#]/)[0].split('/').filter(Boolean)
  if (segs[0] === 'collections') return segs.length >= 3 ? 'record' : 'list'
  if (segs[0] === 'queues' && segs[1]) return 'queue'
  if (segs[0] === 'reports' || segs[0] === 'scheduled-reports') return 'report'
  if (segs[0] === 'dashboards' || segs[0] === 'command') return 'dashboard'
  return 'home'
}

/**
 * Templates only — names, never values. `name` is the collection's readable
 * name, `ref` the record the page shows ("workflows #12") when the asker can
 * open it.
 */
export function pageStarters(
  kind: PageKind,
  ctx: { name?: string | null; ref?: string | null; queueId?: string | null }
): string[] {
  const name = ctx.name || 'records'
  switch (kind) {
    case 'record':
      return ctx.ref
        ? [
            `Why is ${ctx.ref} late?`,
            `Who can act on ${ctx.ref} right now?`,
            `What changed on ${ctx.ref} recently?`
          ]
        : []
    case 'queue':
      return ctx.queueId
        ? [
            `Which records in queue ${ctx.queueId} breach their SLA today?`,
            `What has been sitting longest in queue ${ctx.queueId}?`
          ]
        : []
    case 'list':
      return [
        `How many ${name} are there in each state?`,
        `Which ${name} were created in the last 7 days?`
      ]
    case 'report':
      return ['What changed since last month?', 'Which figure moved the most?']
    case 'dashboard':
      return ['What needs my attention today?', 'What changed since yesterday?']
    default:
      return [
        'How many records are in each collection?',
        'What changed in the last 7 days?',
        'What is waiting on me?'
      ]
  }
}

export async function startersFor(
  user: User,
  opts: { page?: string; collection?: string; id?: string }
): Promise<Starter[]> {
  const page = String(opts.page ?? '/').slice(0, 140)
  const kind = pageKindOf(page)
  const segs = page.split('/').filter(Boolean)
  const collection = /^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.collection ?? '')
    ? (opts.collection as string)
    : kind === 'record' || kind === 'list'
      ? ''
      : ''
  const out: Starter[] = []

  let name: string | null = null
  let readable = false
  if (collection && !/^(nivaro|directus)_/.test(collection)) {
    readable = await can(user, 'read', collection).catch(() => false)
    if (readable) {
      const meta = (await db('nivaro_collections')
        .where({ collection })
        .first('display_name')
        .catch(() => null)) as { display_name: string | null } | null
      name = (meta?.display_name || collection).replace(/_/g, ' ')
    }
  }

  let ref: string | null = null
  if (kind === 'record' && readable && opts.id && /^[\w-]{1,64}$/.test(opts.id)) {
    // Only name a record the asker can open (null = 404, never a hint it exists).
    const { readOne } = await import('./items.js')
    const row = await readOne(user, collection, opts.id, undefined, ['id']).catch(() => null)
    if (row) ref = `${name} #${opts.id}`
  }

  const queueId = kind === 'queue' && segs[1] && /^[\w-]{1,64}$/.test(segs[1]) ? segs[1] : null
  for (const q of pageStarters(kind, { name, ref, queueId }))
    out.push({ question: q, source: 'page' })

  if (readable) {
    const { dataGuideFor } = await import('./ai-knowledge.js')
    const guide = await dataGuideFor(collection).catch(() => null)
    for (const ex of guide?.examples ?? []) {
      const q = scrubText(String(ex).replace(/\s+/g, ' ').trim()).slice(0, 140)
      if (q) out.push({ question: q, source: 'guide' })
    }
  }
  const seen = new Set<string>()
  return out
    .filter((s) => {
      const k = s.question.toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, 5)
}

// ── Saved views (#1942) ──────────────────────────────────────────────────────

export interface VisibleView {
  id: number
  collection: string
  name: string
  filters: string | null
  sort: string | null
  columns: string | null
  is_shared: boolean | number
  user: string
}

/**
 * The saved views this asker may use: their own, plus shared ones that are
 * for everyone or for their role. Mirrors GET /saved-views (routes/saved-views.ts)
 * — keep the two in step.
 */
export async function visibleSavedViews(
  user: User,
  opts: { collection?: string; limit?: number } = {}
): Promise<VisibleView[]> {
  const q = db('nivaro_saved_views')
    .where((qb) => {
      qb.where({ user: user.id }).orWhere((shared) => {
        shared.where('is_shared', true).andWhere((roleQb) => {
          roleQb.whereNull('role')
          if (user.role) roleQb.orWhere('role', user.role)
        })
      })
    })
    .orderBy('created_at', 'asc')
    .limit(opts.limit ?? 200)
    .select('id', 'collection', 'name', 'filters', 'sort', 'columns', 'is_shared', 'user')
  if (opts.collection) q.where({ collection: opts.collection })
  return ((await q.catch(() => [])) as VisibleView[]) ?? []
}

const clean = (s: string, n: number) =>
  scrubText(
    s
      .replace(/[`\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  ).slice(0, n)

/** One prompt line per visible view; the caller drops collections the asker cannot read. */
export async function savedViewCatalogue(
  user: User
): Promise<Array<{ collection: string; line: string }>> {
  const views = await visibleSavedViews(user, { limit: 40 })
  return views.map((v) => ({
    collection: v.collection,
    line: `- ${v.collection} — ${clean(String(v.name), 60)}`
  }))
}

/** Best match for a spoken name: exact (case-insensitive), then a unique contains. */
export function matchViewName<T extends { name: string }>(
  views: T[],
  spoken: string
): { match: T | null; candidates: T[] } {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  const want = norm(spoken)
  if (!want) return { match: null, candidates: [] }
  const exact = views.filter((v) => norm(v.name) === want)
  if (exact.length === 1) return { match: exact[0], candidates: exact }
  if (exact.length > 1) return { match: null, candidates: exact }
  const partial = views.filter((v) => norm(v.name).includes(want) || want.includes(norm(v.name)))
  if (partial.length === 1) return { match: partial[0], candidates: partial }
  return { match: null, candidates: partial }
}

/** A saved view's UI conditions as the chat filter dialect ({"a.b": {"_op": v}}). */
export function conditionsToChatFilter(
  conds: Array<{ path: string[]; op: string; value: unknown }>,
  allowedOps: Set<string>
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const c of conds) {
    const key = c.path.join('.')
    if (c.path[0] === '$state') {
      const vals = Array.isArray(c.value) ? c.value : [c.value]
      out.$state = { _in: vals.map(String) }
      continue
    }
    if (!allowedOps.has(c.op)) {
      throw new Error(`This view uses a filter ("${c.op}") that cannot be expressed here.`)
    }
    const slot = out[key] ?? {}
    if (c.op in slot) throw new Error(`This view filters "${key}" twice with ${c.op}.`)
    slot[c.op] = c.value
    out[key] = slot
  }
  return out
}

// ── Link labels (choices, compare, drill) ────────────────────────────────────

/**
 * Names for the ids a link column holds, read AS THE ASKER (readItems: policies,
 * row filters, scopes). An id the asker cannot read stays unlabelled — callers
 * show `#id`, never a name from a raw read.
 */
export async function linkLabels(
  user: User,
  collection: string,
  field: string,
  ids: unknown[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const clean_ids = [...new Set(ids.filter((v) => v != null && v !== '').map(String))].slice(0, 40)
  if (!clean_ids.length) return out
  const { chatRelationsFor, chatLabelColumn } = await import('./ai-chat.js')
  const rel = await chatRelationsFor(collection).catch(() => null)
  const target = rel?.m2o.find((r) => r.field === field)?.collection
  if (!target || !(await can(user, 'read', target).catch(() => false))) return out
  const col = await chatLabelColumn(target)
  const { readItems } = await import('./items.js')
  try {
    const res = (await readItems(user, target, {
      filter: { id: { _in: clean_ids } },
      fields: col === 'id' ? ['id'] : ['id', col],
      limit: clean_ids.length
    })) as { data?: Array<Record<string, unknown>> }
    for (const row of res.data ?? []) {
      const label = row[col]
      if (typeof label === 'string' && label.trim()) out.set(String(row.id), clean(label, 80))
    }
  } catch {
    /* unreadable target: ids stay unlabelled */
  }
  return out
}
