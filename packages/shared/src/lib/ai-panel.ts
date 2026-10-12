/**
 * Pure helpers for the Ask AI panel: follow-up blocks (#1834), slash commands
 * (#1884), chart drill sources (#1943) and live-answer sources (#1996). The
 * server twin of stripFollowUps is api/src/services/ai-panel.ts extractFollowUps.
 */

export interface PanelTraceEntry {
  tool: string
  input: Record<string, unknown>
  summary: string
}

// ── Follow-ups ───────────────────────────────────────────────────────────────

const FOLLOWUPS_BLOCK = /\n*```followups\s*\n[\s\S]*?```\s*$/i
// While streaming, the block arrives piece by piece: hide a started-but-open one.
const FOLLOWUPS_OPEN = /\n*```f(?:o(?:l(?:l(?:o(?:w(?:u(?:p(?:s)?)?)?)?)?)?)?)?[\s\S]*$/i

/** An answer without its trailing ```followups block (complete or still arriving). */
export function stripFollowUps(text: string): string {
  const closed = text.replace(FOLLOWUPS_BLOCK, '')
  if (closed !== text) return closed
  const open = FOLLOWUPS_OPEN.exec(text)
  if (open && /^\n*```f/i.test(open[0]) && !/^\n*```followups[\s\S]*```\s*$/i.test(open[0])) {
    // only strip when the open fence is at the very end (no later closing fence)
    const rest = open[0].replace(/^\n*```/, '')
    if (!rest.includes('```')) return text.slice(0, open.index)
  }
  return text
}

// ── Slash commands ───────────────────────────────────────────────────────────

export interface SlashCommand {
  name: 'chart' | 'table' | 'export' | 'explain' | 'steps'
  hint: string
  /** Sent to the server as `command` (answer format); export is handled in the panel. */
  server: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'chart', hint: 'Answer as a chart', server: true },
  { name: 'table', hint: 'Answer as a table', server: true },
  { name: 'export', hint: 'Download the last answer’s rows', server: false },
  { name: 'explain', hint: 'Explain how the last answer was reached', server: true },
  { name: 'steps', hint: 'Answer as numbered steps', server: true }
]

/** Commands to list while a person types "/" with no space yet. */
export function slashMatches(input: string): SlashCommand[] {
  const m = /^\/(\w*)$/.exec(input)
  if (!m) return []
  const p = m[1].toLowerCase()
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(p))
}

/** "/chart spend by zone" → {command, rest}; null when it is not a known command. */
export function parseSlash(input: string): { command: SlashCommand; rest: string } | null {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(input.trim())
  if (!m) return null
  const command = SLASH_COMMANDS.find((c) => c.name === m[1].toLowerCase())
  return command ? { command, rest: (m[2] ?? '').trim() } : null
}

/** The question a command with nothing after it stands for. */
export function defaultQuestionFor(command: SlashCommand['name']): string {
  switch (command) {
    case 'explain':
      return 'Explain how you got that answer.'
    case 'chart':
      return 'Show that as a chart.'
    case 'table':
      return 'Show that as a table.'
    case 'steps':
      return 'Give that to me as numbered steps.'
    default:
      return ''
  }
}

// ── Chart drill (#1943) ──────────────────────────────────────────────────────

export interface DrillSource {
  collection: string
  group_by: string
  filter?: unknown
}

const ok = (t: PanelTraceEntry) => !t.summary?.startsWith('error:')

/**
 * The grouped aggregate a chart came from: the last successful `aggregate`
 * with a group_by, preferring one whose group count matches the chart's
 * points. Null when the chart was not drawn from a grouping (nothing to drill).
 */
export function drillSourceFor(trace: PanelTraceEntry[], points: number): DrillSource | null {
  const grouped = trace.filter(
    (t) =>
      t.tool === 'aggregate' &&
      ok(t) &&
      typeof t.input.group_by === 'string' &&
      typeof t.input.collection === 'string'
  )
  if (!grouped.length) return null
  const countOf = (t: PanelTraceEntry) => Number(/(\d+) group\(s\)/.exec(t.summary)?.[1] ?? NaN)
  const pick =
    [...grouped].reverse().find((t) => countOf(t) === points) ?? grouped[grouped.length - 1]
  return {
    collection: pick.input.collection as string,
    group_by: pick.input.group_by as string,
    filter: pick.input.filter
  }
}

// ── Live answers (#1996) ─────────────────────────────────────────────────────

export interface LiveSource {
  input: {
    collection: string
    op: string
    field?: string
    group_by?: string
    filter?: unknown
  }
}

const LIVE_OK_TOOLS = new Set(['aggregate', 'list_collections'])

/**
 * The aggregates behind a number or chart answer, when the answer was built
 * from nothing else — only then can re-running them stand in for the answer.
 * Empty = not live-capable. At most three, so a refresh stays cheap.
 */
export function liveSourcesFor(trace: PanelTraceEntry[] | undefined): LiveSource[] {
  const good = (trace ?? []).filter(ok)
  if (!good.length || !good.every((t) => LIVE_OK_TOOLS.has(t.tool))) return []
  const out: LiveSource[] = []
  for (const t of good) {
    if (t.tool !== 'aggregate' || typeof t.input.collection !== 'string') continue
    out.push({
      input: {
        collection: t.input.collection,
        op: String(t.input.op ?? 'count'),
        ...(typeof t.input.field === 'string' ? { field: t.input.field } : {}),
        ...(typeof t.input.group_by === 'string' ? { group_by: t.input.group_by } : {}),
        ...(t.input.filter ? { filter: t.input.filter } : {})
      }
    })
    if (out.length >= 3) break
  }
  return out
}
