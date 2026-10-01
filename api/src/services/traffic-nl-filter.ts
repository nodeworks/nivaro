// api/src/services/traffic-nl-filter.ts
/**
 * #1133 — natural-language filter for the Traffic Map. One small AI call with a forced tool call
 * (structured output) turns "show only writes by integrations to forecasts in the last 5 minutes"
 * into the map's own filters. The model only ever picks from what the page sent (the lanes,
 * kinds and windows the map has, the callers and entities it currently shows), and every value is
 * checked again here, so nothing it invents reaches the page.
 */

export const NL_LANES = [
  'items',
  'widgets',
  'pages',
  'queries',
  'graphql',
  'inbound',
  'files',
  'extension',
  'system',
  'socket'
] as const
export const NL_KINDS = ['read', 'create', 'update', 'delete', 'error'] as const
export const NL_CALLER_KINDS = ['key', 'person', 'machine', 'cron', 'source', 'anon'] as const
export const NL_WINDOWS = [60, 300, 900] as const
const MAX_PROMPT = 400
const MAX_CALLERS = 80
const MAX_ENTITIES = 150

export interface NlVocabulary {
  callers: Array<{ key: string; label: string; kind: string }>
  entities: Array<{ key: string; label: string }>
}
export interface NlFilter {
  lanes: string[] | null
  kinds: string[] | null
  caller: string | null
  caller_kind: string | null
  window: number | null
  entity: string | null
  /** One plain sentence: what the filters show. */
  summary: string
}

const KEY_RE = /^[A-Za-z0-9_:.>\-/]{1,160}$/

/** The page's vocabulary, trimmed and shape-checked (it is request input). */
export function cleanVocabulary(raw: unknown): NlVocabulary {
  const v = (raw ?? {}) as { callers?: unknown; entities?: unknown }
  const callers = (Array.isArray(v.callers) ? v.callers : [])
    .filter(
      (c): c is { key: string; label: string; kind: string } =>
        !!c &&
        typeof c === 'object' &&
        typeof (c as { key?: unknown }).key === 'string' &&
        KEY_RE.test((c as { key: string }).key)
    )
    .slice(0, MAX_CALLERS)
    .map((c) => ({
      key: c.key,
      label: String(c.label ?? c.key).slice(0, 80),
      kind: (NL_CALLER_KINDS as readonly string[]).includes(String(c.kind))
        ? String(c.kind)
        : 'person'
    }))
  const entities = (Array.isArray(v.entities) ? v.entities : [])
    .filter(
      (e): e is { key: string; label: string } =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as { key?: unknown }).key === 'string' &&
        KEY_RE.test((e as { key: string }).key)
    )
    .slice(0, MAX_ENTITIES)
    .map((e) => ({ key: e.key, label: String(e.label ?? e.key).slice(0, 80) }))
  return { callers, entities }
}

export function cleanPrompt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const p = raw.replace(/\s+/g, ' ').trim()
  return p ? p.slice(0, MAX_PROMPT) : null
}

export const NL_TOOL = {
  name: 'set_filters',
  description:
    'Set the Traffic Map filters. Use null for anything the request does not mention (it keeps the current value).',
  input_schema: {
    type: 'object' as const,
    properties: {
      lanes: {
        type: ['array', 'null'],
        items: { type: 'string', enum: [...NL_LANES] },
        description:
          'API lanes to show. items = collections (records), widgets, pages, queries = custom queries, graphql, inbound = inbound mappings, files, extension routes, system = nivaro_* tables, socket = socket.io events.'
      },
      kinds: {
        type: ['array', 'null'],
        items: { type: 'string', enum: [...NL_KINDS] },
        description: '"writes" = create, update and delete. "errors" = error.'
      },
      caller: {
        type: ['string', 'null'],
        description: 'One caller key from the list, when the request names one caller.'
      },
      caller_kind: {
        type: ['string', 'null'],
        enum: [...NL_CALLER_KINDS, null],
        description:
          'A kind of caller: key = API keys, machine = integration accounts, person = signed-in people, cron = scheduled jobs and flows, source = imports and other non-request sources, anon = no credentials. "integrations" = key and machine: pick machine unless keys are named.'
      },
      window: {
        type: ['integer', 'null'],
        enum: [...NL_WINDOWS, null],
        description: 'Seconds: 60 = last minute, 300 = last 5 minutes, 900 = last 15 minutes.'
      },
      entity: {
        type: ['string', 'null'],
        description:
          'One entity key from the list, when the request names one collection, page, widget or query.'
      },
      summary: { type: 'string', description: 'One short sentence saying what will be shown.' }
    },
    required: ['summary']
  }
}

export function systemPrompt(v: NlVocabulary): string {
  const callers = v.callers.map((c) => `- ${c.key}: ${c.label} (${c.kind})`).join('\n') || '- none'
  const entities = v.entities.map((e) => `- ${e.key}: ${e.label}`).join('\n') || '- none'
  return `You turn a request about API traffic into filters for a live traffic map. Call set_filters once. Only use values from the lists below; never invent a key.

Callers on the map now:
${callers}

Entities on the map now (key: label):
${entities}`
}

/** The model's tool input, checked against the enums and the page's own lists. */
export function validateNlFilter(input: unknown, v: NlVocabulary): NlFilter {
  const i = (input ?? {}) as Record<string, unknown>
  const pick = (raw: unknown, allowed: readonly string[]) => {
    // an OpenAI-shaped gateway can hand nested arguments back as JSON strings
    let arr = raw
    if (typeof arr === 'string') {
      try {
        arr = JSON.parse(arr)
      } catch {
        arr = [arr]
      }
    }
    if (!Array.isArray(arr)) return null
    const out = [...new Set(arr.map(String).filter((x) => allowed.includes(x)))]
    return out.length ? out : null
  }
  const callerKeys = new Set(v.callers.map((c) => c.key))
  const entityKeys = new Set(v.entities.map((e) => e.key))
  const caller = typeof i.caller === 'string' && callerKeys.has(i.caller) ? i.caller : null
  const callerKind =
    !caller &&
    typeof i.caller_kind === 'string' &&
    (NL_CALLER_KINDS as readonly string[]).includes(i.caller_kind)
      ? i.caller_kind
      : null
  const win = Number(i.window)
  return {
    lanes: pick(i.lanes, NL_LANES),
    kinds: pick(i.kinds, NL_KINDS),
    caller,
    caller_kind: callerKind,
    window: (NL_WINDOWS as readonly number[]).includes(win) ? win : null,
    entity: typeof i.entity === 'string' && entityKeys.has(i.entity) ? i.entity : null,
    summary: typeof i.summary === 'string' ? i.summary.slice(0, 200) : ''
  }
}
