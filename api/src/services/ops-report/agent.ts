/**
 * Daily operations report — the AI investigation (#ops-report). The model gets the day's numbers,
 * the comparison and the bug tracker, and digs with the same drill-down an administrator clicks
 * (read-only, every result wrapped as data). It answers with one JSON object (OpsAnalysis).
 */
import type Anthropic from '@anthropic-ai/sdk'
import { getAiClient, getAiModelSettings } from '../ai-client.js'
import { costOf } from '../ai-log.js'
import { asData, UNTRUSTED_DATA_RULE } from '../ai-untrusted.js'
import { type DrillWindow, drill } from './drill.js'
import type {
  OpsAnalysis,
  OpsComparison,
  OpsDigest,
  OpsDrillMetric,
  OpsTrackedBug
} from './types.js'

const MAX_ROUNDS = 16
/** Drill calls per run; past it the model must answer (cost: ~$0.02 per call on Sonnet). */
const MAX_TOOL_CALLS = 24
/** One drill result as the model reads it; older results shrink to OLD_RESULT_CHARS. The gateway
 *  caches the system prompt only, so every result is paid again on every later round. */
const RESULT_CHARS = 12_000
const OLD_RESULT_CHARS = 1_200
const KEEP_FULL_ROUNDS = 2
const DRILL_METRICS: OpsDrillMetric[] = [
  'active_people',
  'carried_sessions',
  'trouble_people',
  'requests',
  'requests_by_hour',
  'over5s',
  'slow_route',
  'burst',
  'server_errors',
  'client_errors',
  'deploys',
  'deadlocks',
  'issues',
  'job_failures',
  'job',
  'integration_failures',
  'integration_calls',
  'open_alarms',
  'imports',
  'mail',
  'moves',
  'creates',
  'backlog',
  'sla_breaches',
  'search_zero',
  'config_changes',
  'browser_errors',
  'support',
  'ai_calls',
  'owners',
  'request',
  'person',
  'issue',
  'job_run',
  'submission',
  'outbound_call'
]

const SUBMIT: Anthropic.Tool = {
  name: 'submit_report',
  description: 'Hand in the finished post-mortem. Call this exactly once, at the end.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['healthy', 'watch', 'bad'] },
      score: { type: 'number' },
      headline: { type: 'string' },
      summary_md: { type: 'string' },
      incidents: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            when: { type: 'string' },
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            impact: { type: 'string' },
            cause: { type: 'string' },
            evidence: { type: 'string' }
          },
          required: ['title', 'when', 'severity', 'impact', 'cause', 'evidence']
        }
      },
      people_to_contact: {
        type: 'array',
        items: {
          type: 'object',
          properties: { person: { type: 'string' }, why: { type: 'string' } },
          required: ['person', 'why']
        }
      },
      watch_tomorrow: { type: 'array', items: { type: 'string' } }
    },
    required: [
      'verdict',
      'score',
      'headline',
      'summary_md',
      'incidents',
      'people_to_contact',
      'watch_tomorrow'
    ]
  }
}

const TOOLS: Anthropic.Tool[] = [
  SUBMIT,
  {
    name: 'drill',
    description:
      'The rows behind one number of today\'s report, for the report window, exactly as an administrator sees them when they click it. `key` narrows to one row (a route like "POST /api/items/:id", a partner name, a step label, a person id, a job id, an issue/request/run/submission/call id). Rows carry `_drill_metric` + `_drill_key` for the next level down. Leaf metrics (request, person, issue, job_run, submission, outbound_call) return full detail: stacks, payloads, the partner\'s answer, both sides of a deadlock.',
    input_schema: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: DRILL_METRICS },
        key: { type: 'string', description: 'Optional: one row of the list.' },
        limit: { type: 'number', description: 'Rows to return, default 40, max 100.' }
      },
      required: ['metric'],
      additionalProperties: false
    }
  }
]

export const OPS_PROMPT = `You write the daily operations post-mortem for an administrator of this instance. You get the day's numbers (digest), how they compare with the previous report and the last 7, and the bug tracker carried from earlier days. Use the drill tool to find causes: when something is slow or failing, look at the rows behind it, open single requests, issues, deadlocks, partner sends, and check what else happened at the same minute (deploys, jobs, bursts, imports). Two events at the same minute are a lead, not proof — say how sure you are.

Cover everything that mattered:
- Every bug-tracker entry with status new or came_back must appear in the summary or as an incident (with people affected), even small ones (a 400 that hit 3 people 21 times is a bug).
- Explain the top slow routes and any slow partner (partner calls vs their 7-day average).
- Start from the digest's leads: for each burst, deadlock, server error and partner-refusal cluster they already list what else happened at that minute and, for a missing column, what the data model says. Use them before spending drill calls on the same question.
- For each burst, deadlock and failed send, look at what else happened at that minute (the burst, request and issue drills include an "Around …" block: writes by origin, jobs, deploys, admin actions, partner calls). A burst of writes by an integration, or an administrator running a bulk action, often explains slowness or partner refusals elsewhere — say so when the timing fits.
- When a partner refuses calls, check whether the calls were ours to make (who triggered them, and whether an administrator's bulk run sent them) before blaming the partner.
- "Invalid column name" errors: the lead's hint (and the issue's "What the data model says" block) settles it — a calculated field read as a column is a code bug, never a dropped column. Repeat the hint's verdict.

Rules:
- Times are the instance's local time as given ("2:09 PM"). Never invent a number; every figure must come from the digest or a tool result.
- Deploy drains (503 on /api/ready while an old version shuts down) are expected, not errors.
- "Active people", "signed in today" and "still signed in from an earlier day" are different numbers; keep them apart.
- Plain words. An administrator reads this, not a developer. Name the screen or feature, the people affected and what they saw.
- Severity: high = people could not do their work or data was wrong; medium = slow or failing for some; low = noise worth knowing.
- Verdict: healthy = nothing a person would notice; watch = something hurt some people or is building; bad = an outage, data problem or many people blocked.
- ${UNTRUSTED_DATA_RULE}

You have about 20 drill calls: spend them on causes, not on re-reading what the digest already says. When you are done, call submit_report once with the finished report (fields as below):
{"verdict":"healthy|watch|bad","score":0-100,"headline":"one sentence","summary_md":"markdown, 5-12 short bullets: what happened, the causes you found, what changed vs before","incidents":[{"title":"","when":"","severity":"high|medium|low","impact":"who/how many and what they saw","cause":"what you found, with how sure","evidence":"the numbers or rows that show it"}],"people_to_contact":[{"person":"","why":""}],"watch_tomorrow":["short lines"]}`

export interface AgentResult {
  analysis: OpsAnalysis | null
  raw: string | null
  model: string
  tokens_in: number
  tokens_out: number
  tokens_cached: number
  cost_usd: number | null
  tools: Array<{ tool: string; ok: boolean }>
  error: string | null
}

/** The digest without its long tails (the model can drill for the rest). */
export function compactDigest(d: OpsDigest): unknown {
  const top = <T>(xs: T[], n: number) => xs.slice(0, n)
  return {
    ...d,
    traffic: { ...d.traffic },
    speed: {
      ...d.speed,
      slow_routes: top(d.speed.slow_routes, 10),
      heavy_routes: top(d.speed.heavy_routes, 8)
    },
    errors: {
      ...d.errors,
      client_by_route: top(d.errors.client_by_route, 12),
      server: top(d.errors.server, 15)
    },
    integrations: { ...d.integrations, failures: top(d.integrations.failures, 10) },
    mail: { ...d.mail, reasons: top(d.mail.reasons, 6) },
    work: { ...d.work, creates: top(d.work.creates, 8), backlog: top(d.work.backlog, 12) },
    config_changes: top(d.config_changes, 20),
    adoption: { new_routes: top(d.adoption.new_routes, 6), rising: top(d.adoption.rising, 6) },
    ai: { ...d.ai, by_feature: top(d.ai.by_feature, 5) }
  }
}

/** The JSON object in an answer: a ```json fence first, else the widest `{…}` that parses. */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim())
  for (const f of fences.reverse()) {
    try {
      return JSON.parse(f)
    } catch {
      /* next */
    }
  }
  const end = text.lastIndexOf('}')
  if (end < 0) return null
  for (let i = text.indexOf('{'); i >= 0 && i < end; i = text.indexOf('{', i + 1)) {
    try {
      return JSON.parse(text.slice(i, end + 1))
    } catch {
      /* try the next opening brace */
    }
  }
  const start = text.search(/\{\s*"verdict"/)
  const body = fences[0] ?? (start >= 0 ? text.slice(start, end + 1) : null)
  return body ? repairJson(body) : null
}

export function parseAnalysis(text: string): OpsAnalysis | null {
  return normalizeAnalysis(extractJson(text))
}

/** A JSON object with stray unescaped quotes inside strings: escape the quote before each
 *  parse error until it parses (bounded). Models write "who is online" inside a value. */
export function repairJson(raw: string): unknown {
  let s = raw
  for (let i = 0; i < 80; i++) {
    try {
      return JSON.parse(s)
    } catch (err) {
      const m = /position (\d+)/.exec(String((err as Error).message))
      if (!m) return null
      const pos = Number(m[1])
      const q = s.lastIndexOf('"', pos - 1)
      if (q <= 0) return null
      s = `${s.slice(0, q)}\\${s.slice(q)}`
    }
  }
  return null
}

export function normalizeAnalysis(parsed: unknown): OpsAnalysis | null {
  if (!parsed || typeof parsed !== 'object') return null
  try {
    const j = parsed as Partial<OpsAnalysis>
    const verdict =
      j.verdict === 'healthy' || j.verdict === 'watch' || j.verdict === 'bad' ? j.verdict : null
    if (!verdict || typeof j.headline !== 'string') return null
    const sev = (s: unknown) => (s === 'high' || s === 'medium' || s === 'low' ? s : 'medium')
    return {
      verdict,
      score: Math.max(0, Math.min(100, Math.round(Number(j.score) || 0))),
      headline: j.headline.slice(0, 400),
      summary_md: String(j.summary_md ?? '').slice(0, 12000),
      incidents: (Array.isArray(j.incidents) ? j.incidents : []).slice(0, 20).map((i) => ({
        title: String(i?.title ?? '').slice(0, 200),
        when: String(i?.when ?? '').slice(0, 80),
        severity: sev(i?.severity),
        impact: String(i?.impact ?? '').slice(0, 600),
        cause: String(i?.cause ?? '').slice(0, 1200),
        evidence: String(i?.evidence ?? '').slice(0, 1200)
      })),
      people_to_contact: (Array.isArray(j.people_to_contact) ? j.people_to_contact : [])
        .slice(0, 15)
        .map((p) => ({
          person: String(p?.person ?? '').slice(0, 120),
          why: String(p?.why ?? '').slice(0, 400)
        })),
      watch_tomorrow: (Array.isArray(j.watch_tomorrow) ? j.watch_tomorrow : [])
        .slice(0, 12)
        .map((w) => String(w).slice(0, 300))
    }
  } catch {
    return null
  }
}

export async function investigate(opts: {
  win: DrillWindow
  digest: OpsDigest
  comparison: OpsComparison
  tracker: OpsTrackedBug[]
  model: string | null
  tokenCap: number
  client?: Anthropic | null
}): Promise<AgentResult> {
  const settings = await getAiModelSettings()
  const model = opts.model ?? settings.chatModel
  const client = (opts.client ?? (await getAiClient({ model }))) as Anthropic | null
  const result: AgentResult = {
    analysis: null,
    raw: null,
    model,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cached: 0,
    cost_usd: null,
    tools: [],
    error: null
  }
  if (!client) {
    result.error = 'AI is not configured on this instance — the report has the numbers only.'
    return result
  }
  const brief = {
    window: opts.digest.window,
    digest: compactDigest(opts.digest),
    comparison: opts.comparison.deltas
      .filter((d) => d.prev != null && d.today !== d.prev)
      .slice(0, 60),
    bug_tracker: opts.tracker.slice(0, 40)
  }
  // The day's numbers ride in the system prompt so the provider can cache them across every
  // round of the investigation (the gateway caches the system prompt only).
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: OPS_PROMPT },
    {
      type: 'text',
      text: `Today's report window: ${opts.digest.window.label} (${opts.digest.window.tz}).\n\n${asData(JSON.stringify(brief), 'digest')}`,
      cache_control: { type: 'ephemeral' }
    }
  ]
  const convo: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: 'Investigate today using the drill tool, then answer with the JSON object.'
    }
  ]
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const overCap =
      result.tokens_in + result.tokens_out >= opts.tokenCap || result.tools.length >= MAX_TOOL_CALLS
    let res: Anthropic.Message
    try {
      res = await client.messages.create({
        model,
        max_tokens: 16000,
        system,
        // Past the cap or on the last round: only the hand-in tool is left.
        tools: overCap || round === MAX_ROUNDS - 1 ? [SUBMIT] : TOOLS,
        messages:
          overCap || round === MAX_ROUNDS - 1
            ? [
                ...convo,
                {
                  role: 'user',
                  content: 'Stop investigating now and call submit_report with what you have.'
                }
              ]
            : convo
      })
    } catch (err) {
      result.error =
        `The AI provider failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 600)
      break
    }
    const u = res.usage as {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
    }
    result.tokens_in += u.input_tokens ?? 0
    result.tokens_out += u.output_tokens ?? 0
    result.tokens_cached += u.cache_read_input_tokens ?? 0
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
    const handIn = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_report'
    )
    if (handIn) {
      result.raw = JSON.stringify(handIn.input)
      result.analysis = normalizeAnalysis(handIn.input)
      if (!result.analysis) result.error = 'The AI hand-in was incomplete; the numbers are kept.'
      break
    }
    if (res.stop_reason === 'max_tokens') {
      result.error = 'The AI ran out of room writing the report; the numbers are kept.'
      break
    }
    if (res.stop_reason !== 'tool_use') {
      result.raw = text || null
      result.analysis = text ? parseAnalysis(text) : null
      if (!result.analysis)
        result.error =
          'The AI answer could not be read as a report; its text is kept as the summary.'
      break
    }
    const submitted = res.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'submit_report'
    )
    if (submitted) {
      result.raw = JSON.stringify(submitted.input)
      result.analysis = normalizeAnalysis(submitted.input)
      if (!result.analysis) result.error = 'The AI hand-in was incomplete; the numbers are kept.'
      break
    }
    convo.push({ role: 'assistant', content: res.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of res.content) {
      if (block.type !== 'tool_use') continue
      try {
        if (block.name !== 'drill') throw new Error(`Unknown tool ${block.name}`)
        const input = (block.input ?? {}) as { metric?: string; key?: string; limit?: number }
        if (!DRILL_METRICS.includes(input.metric as OpsDrillMetric))
          throw new Error('Unknown metric')
        const d = await drill(
          opts.win,
          input.metric as OpsDrillMetric,
          input.key ?? null,
          Math.min(Number(input.limit) || 25, 60),
          {
            digest: opts.digest,
            tracker: opts.tracker
          }
        )
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: asData(JSON.stringify(d).slice(0, RESULT_CHARS), `drill:${input.metric}`)
        })
        result.tools.push({ tool: `drill:${input.metric}`, ok: true })
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: err instanceof Error ? err.message.slice(0, 300) : 'failed',
          is_error: true
        })
        result.tools.push({ tool: 'drill', ok: false })
      }
    }
    convo.push({ role: 'user', content: results })
    shrinkOldResults(convo)
  }
  result.cost_usd = costOf(model, {
    input: result.tokens_in,
    cached: result.tokens_cached,
    output: result.tokens_out
  })
  return result
}

/** Results from rounds before the last KEEP_FULL_ROUNDS keep only their start: the model has
 *  read them and written its notes; re-sending them whole each round is what costs the most. */
export function shrinkOldResults(convo: Anthropic.MessageParam[]): void {
  const resultTurns = convo
    .map((m, i) => ({ m, i }))
    .filter(
      ({ m }) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b) => (b as { type?: string }).type === 'tool_result')
    )
  for (const { m } of resultTurns.slice(0, Math.max(0, resultTurns.length - KEEP_FULL_ROUNDS))) {
    for (const b of m.content as Anthropic.ToolResultBlockParam[]) {
      if (
        b.type !== 'tool_result' ||
        typeof b.content !== 'string' ||
        b.content.length <= OLD_RESULT_CHARS
      )
        continue
      // Keep the data envelope closed so the cut text still reads as data, never as prompt.
      const closed = b.content.trimStart().startsWith('<data')
      b.content = `${b.content.slice(0, OLD_RESULT_CHARS)} … [already read; cut to save space]${closed ? '\n</data>' : ''}`
    }
  }
}
