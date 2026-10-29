import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'
import { hasChainColumns } from './chain-columns.js'
import { selectInChunks } from './db-batch.js'
import { WINDOW_DAYS } from './mcp-activity.js'
import { hasMcpLogColumns } from './mcp-calls.js'

/**
 * Composite tool suggestions (#3206): sequences of MCP tool calls assistants keep making one
 * after another — "search, then read_item, then update_item" — found in the request log's MCP
 * rows (migration 480, services/mcp-calls.ts), each offered as one named tool (#2464,
 * /mcp/tools) an administrator can build from a saved query or a flow.
 *
 * Mining is pure (mineSequences): per connection, calls in time order are cut into sessions at
 * a quiet gap, repeats of one tool in a row fold into one step, and every run of 2–4 steps with
 * at least two different tools is counted once per session. Patterns made only of discovery
 * calls (whoami, list_collections…) are not suggestions, and a pattern is dropped when a longer
 * one covers nearly all of its sessions. Arguments are never logged, so a suggestion names tools
 * and the collections their calls touched, never values.
 */

export const DISMISS_TABLE = 'nivaro_mcp_tool_suggestion_dismissals'
const DAY = 86_400_000
const ROW_CAP = 50_000

export interface CallRow {
  conn: string
  user: string | null
  tool: string
  /** ms since epoch */
  at: number
  chain?: string | null
}

export interface Suggestion {
  /** The tools joined with `>` — the dismissal key. */
  key: string
  tools: string[]
  /** Sessions the pattern appeared in, and how often in all. */
  sessions: number
  occurrences: number
  connections: number
  people: number
  last_seen_at: string
  /** Collections the pattern's calls touched most (from their in-process requests). */
  collections: string[]
  /** A ready name/description for the tool editor. */
  prefill: {
    name: string
    description: string
    kind: 'custom_query' | 'flow'
    read_only: boolean
  }
}

/** Calls that only find out what is there: a pattern of these alone is not a job. */
export const DISCOVERY_TOOLS = new Set([
  'whoami',
  'list_collections',
  'describe_collection',
  'list_instance_tools',
  'list_custom_queries',
  'list_dashboards',
  'list_queues'
])

export interface MineOptions {
  /** A quiet gap this long starts a new session. */
  gapMs?: number
  minLen?: number
  maxLen?: number
  /** Fewest sessions a pattern needs. */
  minSessions?: number
  /** A shorter pattern is dropped when a longer one holds this share of its sessions. */
  coverShare?: number
  limit?: number
}

interface Acc {
  tools: string[]
  sessions: number
  occurrences: number
  conns: Set<string>
  people: Set<string>
  last: number
  chains: string[]
}

/** Pure: the repeated multi-call patterns in a set of calls, best first. */
export function mineSequences(
  rows: CallRow[],
  opts: MineOptions = {}
): Array<Omit<Suggestion, 'collections' | 'prefill'> & { chains: string[] }> {
  const gapMs = opts.gapMs ?? 5 * 60_000
  const minLen = Math.max(2, opts.minLen ?? 2)
  const maxLen = Math.max(minLen, opts.maxLen ?? 4)
  const minSessions = opts.minSessions ?? 3
  const coverShare = opts.coverShare ?? 0.8
  const limit = opts.limit ?? 10

  const byConn = new Map<string, CallRow[]>()
  for (const r of rows) {
    if (!r.tool) continue
    const list = byConn.get(r.conn) ?? []
    list.push(r)
    byConn.set(r.conn, list)
  }

  const acc = new Map<string, Acc>()
  for (const [conn, list] of byConn) {
    list.sort((a, b) => a.at - b.at)
    let session: CallRow[] = []
    const flush = () => {
      if (session.length >= minLen) countSession(conn, session)
      session = []
    }
    const countSession = (c: string, calls: CallRow[]) => {
      // Fold repeats in a row: read_item ×5 is one step.
      const steps: CallRow[][] = []
      for (const call of calls) {
        const last = steps[steps.length - 1]
        if (last && last[0].tool === call.tool) last.push(call)
        else steps.push([call])
      }
      const seenHere = new Set<string>()
      for (let len = minLen; len <= maxLen; len++) {
        for (let i = 0; i + len <= steps.length; i++) {
          const run = steps.slice(i, i + len)
          const tools = run.map((s) => s[0].tool)
          if (new Set(tools).size < 2) continue
          if (tools.every((t) => DISCOVERY_TOOLS.has(t))) continue
          const key = tools.join('>')
          let a = acc.get(key)
          if (!a) {
            a = {
              tools,
              sessions: 0,
              occurrences: 0,
              conns: new Set(),
              people: new Set(),
              last: 0,
              chains: []
            }
            acc.set(key, a)
          }
          a.occurrences++
          if (!seenHere.has(key)) {
            seenHere.add(key)
            a.sessions++
          }
          a.conns.add(c)
          for (const step of run)
            for (const call of step) {
              if (call.user) a.people.add(call.user.toLowerCase())
              if (call.at > a.last) a.last = call.at
              if (call.chain && a.chains.length < 40) a.chains.push(call.chain)
            }
        }
      }
    }
    let prev = -Infinity
    for (const r of list) {
      if (r.at - prev > gapMs) flush()
      session.push(r)
      prev = r.at
    }
    flush()
  }

  const kept = [...acc.entries()].filter(([, a]) => a.sessions >= minSessions)
  // Drop a pattern a longer one (containing it) covers nearly all of.
  const isSub = (small: string[], big: string[]) => {
    if (small.length >= big.length) return false
    for (let i = 0; i + small.length <= big.length; i++)
      if (small.every((t, j) => big[i + j] === t)) return true
    return false
  }
  const out = kept.filter(
    ([, a]) =>
      !kept.some(([, b]) => isSub(a.tools, b.tools) && b.sessions >= a.sessions * coverShare)
  )
  return out
    .map(([key, a]) => ({
      key,
      tools: a.tools,
      sessions: a.sessions,
      occurrences: a.occurrences,
      connections: a.conns.size,
      people: a.people.size,
      last_seen_at: new Date(a.last).toISOString(),
      chains: a.chains
    }))
    .sort(
      (x, y) =>
        y.sessions * (y.tools.length - 1) - x.sessions * (x.tools.length - 1) ||
        y.sessions - x.sessions ||
        x.key.localeCompare(y.key)
    )
    .slice(0, limit)
}

const NAME_RE = /^[a-z][a-z0-9_]{2,47}$/

/** Pure: a tool name for a pattern — first and last step, valid and not taken. */
export function suggestName(tools: string[], taken: Set<string>): string {
  const first = tools[0]
  const last = tools[tools.length - 1]
  const base = `${first}_then_${last}`.replace(/[^a-z0-9_]/g, '_').slice(0, 44)
  let name = NAME_RE.test(base) ? base : `combined_${base}`.slice(0, 44)
  let n = 2
  while (taken.has(name)) name = `${base.slice(0, 41)}_${n++}`
  return name
}

/** Pure: the editor prefill for one pattern. */
export function prefillFor(
  s: { tools: string[]; sessions: number; collections: string[] },
  readOnly: Set<string>,
  taken: Set<string>
): Suggestion['prefill'] {
  const on = s.collections.length ? ` on ${s.collections.join(', ')}` : ''
  const allRead = s.tools.every((t) => readOnly.has(t))
  return {
    name: suggestName(s.tools, taken),
    description: `Does in one call what assistants did in ${s.sessions} sessions with ${s.tools.join(' → ')}${on}. Describe what it returns and when to use it.`,
    // One query can answer a chain of reads; a chain that writes needs a flow.
    kind: allRead ? 'custom_query' : 'flow',
    read_only: allRead
  }
}

const COLL_PATH = /^\/api\/items\/([A-Za-z0-9_]+)/

/** Pure: the most-touched collections in a list of request paths (system tables left out). */
export function topCollections(paths: string[], n = 3): string[] {
  const counts = new Map<string, number>()
  for (const p of paths) {
    const m = p.match(COLL_PATH)
    if (!m || /^(nivaro_|directus_)/i.test(m[1])) continue
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([c]) => c)
}

export async function dismissalsReady(): Promise<boolean> {
  return hasColumn(DISMISS_TABLE, 'pattern_key').catch(() => false)
}

export async function dismissedKeys(): Promise<Set<string>> {
  if (!(await dismissalsReady())) return new Set()
  const rows = (await db(DISMISS_TABLE).select('pattern_key').limit(5_000)) as Array<{
    pattern_key: string
  }>
  return new Set(rows.map((r) => r.pattern_key))
}

export async function dismiss(key: string, userId: string): Promise<void> {
  await db(DISMISS_TABLE).where({ pattern_key: key }).delete()
  await db(DISMISS_TABLE).insert({
    pattern_key: key,
    dismissed_by: userId,
    dismissed_at: new Date()
  })
  cache.clear()
}

export async function undismiss(key: string): Promise<boolean> {
  const n = await db(DISMISS_TABLE).where({ pattern_key: key }).delete()
  cache.clear()
  return Number(n) > 0
}

const cache = new Map<string, { at: number; value: Omit<Suggestion, 'prefill'>[] }>()
const CACHE_MS = 5 * 60_000

/** The window's patterns with their collections (no prefill, no dismissal filter). Cached 5 min. */
async function minedPatterns(): Promise<{
  logged: boolean
  patterns: Omit<Suggestion, 'prefill'>[]
}> {
  if (!(await hasMcpLogColumns().catch(() => false))) return { logged: false, patterns: [] }
  const tenant = getTenantId() ?? ''
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < CACHE_MS) return { logged: true, patterns: hit.value }
  const chained = await hasChainColumns('nivaro_api_logs')
  const rows = (await db('nivaro_api_logs')
    .whereNotNull('mcp_conn')
    .whereNotNull('mcp_outcome')
    .whereNotNull('mcp_tool')
    .where('mcp_outcome', 'ok')
    .where('created_at', '>=', new Date(Date.now() - WINDOW_DAYS * DAY))
    .orderBy('created_at', 'desc')
    .limit(ROW_CAP)
    .select(
      'mcp_conn',
      'user',
      'mcp_tool',
      'created_at',
      ...(chained ? ['chain_id'] : [])
    )) as Array<{
    mcp_conn: string
    user: string | null
    mcp_tool: string
    created_at: Date | string
    chain_id?: string | null
  }>
  const mined = mineSequences(
    rows.map((r) => ({
      conn: String(r.mcp_conn).toLowerCase(),
      user: r.user ? String(r.user) : null,
      tool: r.mcp_tool,
      at: new Date(r.created_at).getTime(),
      chain: r.chain_id ?? null
    }))
  )
  const chains = [...new Set(mined.flatMap((m) => m.chains))]
  const inner =
    chained && chains.length
      ? ((await selectInChunks(chains, 500, (chunk) =>
          Promise.resolve(
            db('nivaro_api_logs')
              .whereIn('chain_id', chunk)
              .whereNotNull('mcp_conn')
              .whereNot('path', '/api/mcp')
              .limit(20_000)
              .select('chain_id', 'path')
          )
        ).catch(() => [])) as Array<{ chain_id: string; path: string }>)
      : []
  const pathsByChain = new Map<string, string[]>()
  for (const r of inner) {
    const k = String(r.chain_id).toLowerCase()
    pathsByChain.set(k, [...(pathsByChain.get(k) ?? []), r.path])
  }
  const value = mined.map(({ chains: cs, ...m }) => ({
    ...m,
    collections: topCollections(cs.flatMap((c) => pathsByChain.get(String(c).toLowerCase()) ?? []))
  }))
  cache.set(tenant, { at: Date.now(), value })
  return { logged: true, patterns: value }
}

/** Suggestions for the tools page: dismissed ones left out unless `all`. */
export async function toolSuggestions(opts: {
  all?: boolean
  readOnly: Set<string>
  taken: Set<string>
}): Promise<{ logged: boolean; suggestions: Array<Suggestion & { dismissed: boolean }> }> {
  const [{ logged, patterns }, dismissed] = await Promise.all([minedPatterns(), dismissedKeys()])
  const taken = new Set(opts.taken)
  const suggestions = patterns
    .map((p) => {
      const prefill = prefillFor(p, opts.readOnly, taken)
      taken.add(prefill.name)
      return { ...p, prefill, dismissed: dismissed.has(p.key) }
    })
    .filter((s) => opts.all || !s.dismissed)
  return { logged, suggestions }
}

export function bustSuggestions(): void {
  cache.clear()
}
