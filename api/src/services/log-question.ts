import { db } from '../db/index.js'
import { cleanLogFilter, LOG_AUTH, LOG_LEVELS, LOG_METHODS, type LogFilter } from './log-filters.js'

/**
 * "Ask the logs" (#1914): one small AI call with a forced tool call turns
 * "errors for Beth yesterday afternoon" into the request list's own filter
 * object (services/log-filters.ts). The model is told the filter's field
 * names, the allowed values and the current time — never a log row, a path
 * list or a person list. A person it names comes back as a NAME, resolved
 * here against the user table; the admin sees the chips before anything runs.
 */

const MAX_QUESTION = 400

export function cleanQuestion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const q = raw.replace(/\s+/g, ' ').trim()
  return q ? q.slice(0, MAX_QUESTION) : null
}

export const ASK_LOGS_TOOL = {
  name: 'set_log_filter',
  description:
    'Set the filter for the API request log or the server log. Leave out anything the question does not mention.',
  input_schema: {
    type: 'object' as const,
    properties: {
      target: {
        type: 'string',
        enum: ['requests', 'log'],
        description:
          'requests = the API request log (method, path, status, caller; every server). log = the raw server log lines of this server (level + text), only for questions about log messages.'
      },
      from: {
        type: ['string', 'null'],
        description:
          'ISO 8601 start, with offset, when the question names a time ("yesterday afternoon" = 12:00-18:00 yesterday in the person\'s zone; "today" = since local midnight).'
      },
      to: { type: ['string', 'null'], description: 'ISO 8601 end, with offset.' },
      hours: {
        type: ['integer', 'null'],
        description:
          'Look-back in hours when the question says "last N hours" and gives no from/to.'
      },
      person: {
        type: ['string', 'null'],
        description:
          'The name or email of ONE person whose requests the question is about, exactly as written ("Beth", "beth.ng@…").'
      },
      path: {
        type: ['string', 'null'],
        description:
          'Part of the request path, when a route, collection or endpoint is named (e.g. "/items/orders", "graphql", "/files").'
      },
      method: { type: ['string', 'null'], enum: [...LOG_METHODS, null] },
      status: {
        type: ['string', 'null'],
        description: 'A status class "4xx" / "5xx" or one code like "404".'
      },
      errors: {
        type: ['boolean', 'null'],
        description: 'true for "errors", "failures", "failed calls" (status 400 and above).'
      },
      auth: {
        type: ['string', 'null'],
        enum: [...LOG_AUTH, null],
        description:
          'How the caller signed in: session = people in the browser, token = integration accounts, api_key = API keys, none = anonymous.'
      },
      inbound: {
        type: ['boolean', 'null'],
        description: 'true for "integrations", "machines", "partners", "inbound" callers.'
      },
      level: {
        type: ['string', 'null'],
        enum: [...LOG_LEVELS, null],
        description: 'target=log only: the minimum level.'
      },
      text: {
        type: ['string', 'null'],
        description: 'target=log only: words the log line contains (e.g. "ECONNRESET", "timeout").'
      },
      group: {
        type: ['string', 'null'],
        enum: ['caller', 'path', null],
        description:
          '"who called most" / "top callers" = caller; "which routes" / "busiest paths" = path. Null to list requests.'
      },
      summary: {
        type: 'string',
        description: 'One short sentence saying what will be shown.'
      }
    },
    required: ['target', 'summary']
  }
}

export function askLogsSystemPrompt(now: Date, zone: string, localNow: string): string {
  return `You turn a question about this application's API traffic or server log into a filter. Call set_log_filter once. You never see any log data; only choose filter values.

Current time: ${now.toISOString()} (UTC) — ${localNow} for the person asking (time zone ${zone}). Resolve relative times in their zone and return ISO 8601 with the offset.`
}

export interface AskResult {
  filter: LogFilter
  /** The name the question used for a person, when one could not be pinned to one account. */
  person_query: string | null
  /** Accounts that match the name when there is more than one (or none). */
  people: Array<{ id: string; name: string; email: string | null }>
  summary: string
}

/** The model's tool input → a checked filter + the raw person name. */
export function filterFromToolInput(input: unknown): {
  filter: LogFilter
  person: string | null
  summary: string
} {
  const i = (input ?? {}) as Record<string, unknown>
  const nullish = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : v)
  const filter = cleanLogFilter({
    target: i.target,
    from: nullish(i.from),
    to: nullish(i.to),
    hours: nullish(i.hours),
    path: nullish(i.path),
    method: nullish(i.method),
    status: nullish(i.status),
    errors: i.errors === true,
    auth: nullish(i.auth),
    inbound: i.inbound === true,
    level: nullish(i.level),
    q: nullish(i.text),
    group: nullish(i.group)
  })
  // A window the model inverted or pushed into the future is not a filter.
  if (filter.from && filter.to && filter.from > filter.to) delete filter.to
  if (filter.from && Date.parse(filter.from) > Date.now()) delete filter.from
  const person =
    typeof i.person === 'string' && i.person.trim() ? i.person.trim().slice(0, 120) : null
  return {
    filter,
    person: filter.target === 'requests' ? person : null,
    summary: typeof i.summary === 'string' ? i.summary.slice(0, 200) : ''
  }
}

const nameOf = (u: Record<string, unknown>) =>
  `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? u.id)

/**
 * A name from the question → accounts. Whole-word first/last name or email
 * prefix; machine and bot accounts included (an integration is a caller too).
 */
export async function resolvePeople(
  name: string
): Promise<Array<{ id: string; name: string; email: string | null }>> {
  const words = name.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3)
  if (words.length === 0) return []
  const esc = (s: string) => s.replace(/[%_[]/g, (m) => `[${m}]`)
  const rows = (await db('nivaro_users')
    .where((w) => {
      if (name.includes('@')) w.where('email', 'like', `${esc(name.toLowerCase())}%`)
      else
        for (const word of words) {
          w.where((x) =>
            x
              .where('first_name', 'like', `${esc(word)}%`)
              .orWhere('last_name', 'like', `${esc(word)}%`)
              .orWhere('email', 'like', `${esc(word)}%`)
          )
        }
    })
    .where((w) => w.where('is_redacted', false).orWhereNull('is_redacted'))
    .orderBy('last_access', 'desc')
    .limit(6)
    .select('id', 'first_name', 'last_name', 'email')
    .catch(() => [])) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: String(r.id).toUpperCase(),
    name: nameOf(r),
    email: (r.email as string | null) ?? null
  }))
}
