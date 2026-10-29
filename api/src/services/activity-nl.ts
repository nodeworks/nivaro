import {
  ACTIVITY_RANGES,
  type ActivityFilters,
  normalizeActivityFilters
} from './activity-filters.js'

/**
 * Natural-language activity search (#10): "deletes by Sam last week in invoices" → the same
 * structured filters the Activity page's controls set. ONE AI call, forced onto a single tool
 * whose input schema is the filter shape; the answer is validated field by field
 * (normalizeActivityFilters + the known collection/action lists) and the person is resolved
 * by the server, never by the model. Nothing the model writes becomes SQL.
 *
 * With AI off, or when the answer is unusable (no tool call, invalid JSON, refusal), the words
 * go back as plain text search (`q`) — the box always does something.
 */

export interface ActivitySearchCatalog {
  collections: Array<{ name: string; label?: string | null }>
  actions: string[]
}

export interface PersonCandidate {
  id: string
  name: string
  email?: string | null
}

export interface ActivitySearchDeps {
  /** An Anthropic-shaped client, or null when AI is off. */
  client: {
    messages: { create: (params: never) => Promise<unknown> }
  } | null
  model: string
  catalog: ActivitySearchCatalog
  /** People whose name or email matches the words, best first (≤5). */
  findPeople: (text: string) => Promise<PersonCandidate[]>
  now?: Date
}

export interface ActivitySearchResult {
  filters: ActivityFilters
  source: 'ai' | 'text'
  /** Why the plain-text fallback ran, when it did. */
  note?: string
  /** The person the filters name, for the chip. */
  user_label?: string | null
  /** Other people the words could mean (the chip offers them). */
  person_candidates?: PersonCandidate[]
  /** The person words, when no one matched (kept as text search). */
  unmatched_person?: string | null
}

export const ACTIVITY_SEARCH_TOOL_NAME = 'activity_filters'
const ENUM_CAP = 300

export function activitySearchTool(catalog: ActivitySearchCatalog) {
  const collections = catalog.collections.map((c) => c.name)
  const actions = catalog.actions
  const strList = (values: string[], description: string) => ({
    type: 'array',
    description,
    items:
      values.length > 0 && values.length <= ENUM_CAP
        ? { type: 'string', enum: values }
        : { type: 'string' }
  })
  const nullableStr = (description: string) => ({ type: ['string', 'null'], description })
  return {
    name: ACTIVITY_SEARCH_TOOL_NAME,
    description: 'The structured audit-log filters the request asks for.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        person: nullableStr(
          'Name or email of the person who did it, exactly as written. null = anyone.'
        ),
        actions: strList(actions, 'Action kinds asked for (create, update, delete, …). [] = any.'),
        collections: strList(collections, 'Collections the entries are in. [] = any.'),
        range: {
          type: ['string', 'null'],
          enum: [...ACTIVITY_RANGES, null],
          description: 'A relative window. Prefer this over from/to when the words are relative.'
        },
        from: nullableStr('Start date YYYY-MM-DD for an explicit window, else null.'),
        to: nullableStr('End date YYYY-MM-DD (inclusive) for an explicit window, else null.'),
        item: nullableStr('A record id when one is named, else null.'),
        text: nullableStr('Words left over to match in the entry text, else null.')
      },
      required: ['person', 'actions', 'collections', 'range', 'from', 'to', 'item', 'text']
    }
  }
}

function systemPrompt(catalog: ActivitySearchCatalog, now: Date): string {
  const cols = catalog.collections
    .slice(0, 600)
    .map((c) => (c.label && c.label !== c.name ? `${c.name} (${c.label})` : c.name))
    .join(', ')
  return [
    'You turn a search of an application audit log into filters by calling the tool once.',
    `Today is ${now.toISOString().slice(0, 10)} (UTC). Weeks start on Monday.`,
    'Map words to the listed collections and actions only; plural or label words count (e.g. "invoices" → invoices).',
    '"deletes"/"deleted" → delete; "edits"/"changes" → update; "created"/"new" → create.',
    'Leave anything not asked for empty or null. Never invent ids.',
    `Collections: ${cols || '(none)'}`,
    `Actions: ${catalog.actions.slice(0, 400).join(', ') || '(none)'}`
  ].join('\n')
}

/** The tool input from a response, whatever the wire format did with it. */
export function toolInputOf(res: unknown): Record<string, unknown> | null {
  const content = (res as { content?: unknown })?.content
  if (!Array.isArray(content)) return null
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'tool_use') {
      const input = block.input
      if (input && typeof input === 'object' && !Array.isArray(input))
        return input as Record<string, unknown>
      if (typeof input === 'string') {
        try {
          const v = JSON.parse(input)
          if (v && typeof v === 'object' && !Array.isArray(v)) return v
        } catch {
          return null
        }
      }
      return null
    }
  }
  // A model that answered in text: accept a bare JSON object, nothing else.
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const t = block.text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/, '')
        .trim()
      if (!t.startsWith('{')) continue
      try {
        const v = JSON.parse(t)
        if (v && typeof v === 'object' && !Array.isArray(v)) return v
      } catch {
        /* not JSON */
      }
    }
  }
  return null
}

const textOnly = (text: string, note: string): ActivitySearchResult => ({
  filters: { q: text.slice(0, 200) },
  source: 'text',
  note
})

/**
 * The model's input → filters, keeping only what the catalog knows. Pure; exported for tests.
 * The person is NOT resolved here (returned as `person` for the caller).
 */
export function filtersFromToolInput(
  input: Record<string, unknown>,
  catalog: ActivitySearchCatalog
): { filters: ActivityFilters; person: string | null } {
  const knownCols = new Map(catalog.collections.map((c) => [c.name.toLowerCase(), c.name]))
  const knownActions = new Map(catalog.actions.map((a) => [a.toLowerCase(), a]))
  const keep = (v: unknown, known: Map<string, string>) =>
    (Array.isArray(v) ? v : [])
      .map((x) => (typeof x === 'string' ? known.get(x.trim().toLowerCase()) : undefined))
      .filter((x): x is string => !!x)
  const { filters } = normalizeActivityFilters({
    actions: keep(input.actions, knownActions),
    collections: keep(input.collections, knownCols),
    range: typeof input.range === 'string' ? input.range : null,
    from: typeof input.from === 'string' ? input.from : null,
    to: typeof input.to === 'string' ? input.to : null,
    item: typeof input.item === 'string' ? input.item : null,
    q: typeof input.text === 'string' ? input.text : null
  })
  // A relative range wins; never send both.
  if (filters.range) {
    delete filters.from
    delete filters.to
  }
  const person =
    typeof input.person === 'string' && input.person.trim()
      ? input.person.trim().slice(0, 120)
      : null
  return { filters, person }
}

export async function parseActivitySearch(
  text: string,
  deps: ActivitySearchDeps
): Promise<ActivitySearchResult> {
  const words = String(text ?? '')
    .trim()
    .slice(0, 500)
  if (!words) return { filters: {}, source: 'text' }
  if (!deps.client) return textOnly(words, 'AI is off on this instance — searching the words.')

  const now = deps.now ?? new Date()
  let res: unknown
  try {
    res = await deps.client.messages.create({
      model: deps.model,
      max_tokens: 400,
      // Newer Claude models refuse a forced tool_choice (400), so the tool is
      // offered with auto and the prompt asks for exactly one call.
      system: `${systemPrompt(deps.catalog, now)}\nAlways answer by calling the ${ACTIVITY_SEARCH_TOOL_NAME} tool exactly once.`,
      tools: [activitySearchTool(deps.catalog)],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: words }]
    } as never)
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 120) : 'unknown error'
    return textOnly(words, `The AI could not read that (${msg}) — searching the words.`)
  }
  const input = toolInputOf(res)
  if (!input) return textOnly(words, 'The AI answer was not usable — searching the words.')

  const { filters, person } = filtersFromToolInput(input, deps.catalog)
  const out: ActivitySearchResult = { filters, source: 'ai' }
  if (person) {
    const candidates = await deps.findPeople(person).catch(() => [] as PersonCandidate[])
    if (candidates.length > 0) {
      filters.user = candidates[0].id
      out.user_label = candidates[0].name
      if (candidates.length > 1) out.person_candidates = candidates.slice(0, 5)
    } else {
      // Nobody by that name: search the words instead (text search matches names and emails).
      if (!filters.q) filters.q = person
      out.unmatched_person = person
    }
  }
  return out
}
