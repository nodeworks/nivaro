import { liquidWithoutFiles } from '../liquid-no-fs.js'

// Issue text goes to GitLab as markdown, so output is NOT html-escaped.
// No file system (include/render/layout refuse) and hard limits on loops, memory and size.
const engine = liquidWithoutFiles({
  outputEscape: undefined,
  strictVariables: false,
  strictFilters: false,
  renderLimit: 1000,
  memoryLimit: 1e7,
  parseLimit: 1e5
})
const ZWSP = '\u200b'

// Only strict URLs GitLab would autolink are left whole (a zero-width space would break `%2F`
// or `/~user/`): at the start of the text or after whitespace or one of ( * _ ~ [ < (where GitLab
// starts an autolink), then scheme, host, optional port and URL-safe path / query characters — no
// `#`, no quotes or backticks — and trailing . , ; : ! ? ) are not part of it. A `~` inside a kept
// URL becomes %7E (the same URL), so no label reference survives in it. A `#12` after a URL is
// neutralised like any other (its anchor breaks). Security reviews of M3.
const STRICT_URL =
  /(?<=^|[\s(*_~[<])https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:[/?][A-Za-z0-9\-._~%/?=&+,;:@]*)?/g
const URL_TRAIL = /[.,;:!?)]+$/

const neutraliseText = (part: string): string =>
  part.replace(/([#!&$])(?=\d)/g, `$1${ZWSP}`).replace(/([~%])(?=[\p{L}\p{N}_"])/gu, `$1${ZWSP}`)

/**
 * GitLab references in text: `#123` / `group/proj#12` (issue), `!45` (merge request), `&7` (epic),
 * `$5` (snippet) get a zero-width space after the sigil when a digit follows; `~label` and
 * `%milestone` when a word character (or a quote) follows. Final review M3.
 */
function neutraliseReferences(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(STRICT_URL)) {
    const start = m.index ?? 0
    const url = m[0].replace(URL_TRAIL, '')
    out += neutraliseText(text.slice(last, start)) + url.replace(/~/g, '%7E')
    last = start + url.length
  }
  return out + neutraliseText(text.slice(last))
}

/**
 * Makes issue-derived text safe to put in GitLab markdown: a line starting with `/` would run as a
 * quick action (/close, /assign), `@name` would ping a person, `#12` / `!3` / `~label` … would
 * link (and cross-reference) another GitLab issue, merge request, label or milestone. Idempotent.
 */
export function sanitizeMarkdown(text: string, opts?: { singleLine?: boolean }): string {
  let out = neutraliseReferences(
    String(text ?? '')
      .replace(/^([ \t]*)\//gm, `$1${ZWSP}/`)
      .replace(/@(?!\u200b)/g, `@${ZWSP}`)
      .replace(/<!--/g, `<${ZWSP}!--`)
  )
  if (opts?.singleLine) out = out.replace(/[\r\n]+/g, ' ').trim()
  return out
}

/** Wraps text in a language-less backtick fence longer than any backtick run inside it. */
export function fenced(text: string): string {
  const s = String(text ?? '').replace(/<!--/g, `<${ZWSP}!--`)
  let longest = 0
  for (const m of s.match(/`+/g) ?? []) longest = Math.max(longest, m.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${s}\n${fence}`
}
engine.registerFilter('fenced', (v: unknown) => fenced(String(v ?? '')))

const SINGLE_LINE_VARS = [
  'title',
  'raw_title',
  'description',
  'severity',
  'status',
  'source',
  'route',
  'collection',
  'item',
  'environment',
  'build'
]

function sanitizeVars(vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...vars }
  for (const k of SINGLE_LINE_VARS) {
    if (typeof out[k] === 'string')
      out[k] = sanitizeMarkdown(out[k] as string, { singleLine: true })
  }
  if (typeof out.details === 'string') out.details = sanitizeMarkdown(out.details)
  if (Array.isArray(out.top_routes)) {
    out.top_routes = out.top_routes.map((r) =>
      r && typeof r === 'object'
        ? {
            ...(r as Record<string, unknown>),
            route: sanitizeMarkdown(String((r as { route?: unknown }).route ?? ''), {
              singleLine: true
            })
          }
        : r
    )
  }
  if (Array.isArray(out.builds)) {
    out.builds = out.builds.map((b) =>
      typeof b === 'string' ? sanitizeMarkdown(b, { singleLine: true }) : b
    )
  }
  return out
}

/** Title (and label) templates: always one line. */
export async function renderIssueTitle(
  tpl: string,
  vars: Record<string, unknown>
): Promise<string> {
  return sanitizeMarkdown(await renderIssueTemplate(tpl, vars), { singleLine: true })
}
const MAX_OUTPUT = 60000

export const TEMPLATE_VARS: Array<{ name: string; description: string }> = [
  { name: 'title', description: 'The Nivaro issue title, in plain words' },
  { name: 'raw_title', description: 'The issue title exactly as stored (machine text)' },
  {
    name: 'description',
    description: 'What a recognised system issue means and what to do (empty otherwise)'
  },
  { name: 'severity', description: 'info, warning, medium, error or critical' },
  { name: 'status', description: 'Current status of the issue' },
  { name: 'source', description: 'Where it came from (server, client, crash, monitor, ...)' },
  { name: 'details', description: 'Stack or details text (empty when "include details" is off)' },
  { name: 'route', description: 'The route or screen it happened on' },
  { name: 'collection', description: 'The collection involved, if any' },
  { name: 'item', description: 'The record id involved, if any' },
  { name: 'environment', description: 'Environment name' },
  { name: 'build', description: 'Build it was seen in' },
  { name: 'first_seen', description: 'When it was first seen' },
  { name: 'last_seen', description: 'When it was last seen' },
  { name: 'total_hits', description: 'Total number of occurrences' },
  { name: 'hits_24h', description: 'Occurrences in the last 24 hours' },
  { name: 'people_24h', description: 'Distinct people affected in the last 24 hours' },
  { name: 'recurrences', description: 'Times it came back after being resolved' },
  { name: 'top_routes', description: 'Top routes, a list of {route, count}' },
  { name: 'builds', description: 'Builds it was seen in, a list' },
  { name: 'nivaro_url', description: 'Link to the issue in Nivaro' },
  { name: 'group_size', description: 'How many issues are grouped with this one' },
  { name: 'issue_id', description: 'The Nivaro issue id' }
]

export async function renderIssueTemplate(
  tpl: string,
  vars: Record<string, unknown>
): Promise<string> {
  let out: string
  try {
    out = await engine.parseAndRender(tpl, sanitizeVars(vars))
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : 'unknown problem'
    throw new Error(`The template could not be rendered: ${msg}`)
  }
  return out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) : out
}

/** Variables a support-ticket template gets (every string already markdown-safe). */
export const TICKET_TEMPLATE_VARS: Array<{ name: string; description: string }> = [
  { name: 'title', description: 'The request summary' },
  { name: 'description', description: 'What the requester wrote' },
  { name: 'status', description: 'open, in_progress, done or cancelled' },
  { name: 'priority', description: 'low, normal or urgent' },
  { name: 'category', description: 'The request type' },
  { name: 'requester', description: 'Who raised it' },
  { name: 'assignee', description: 'Who works it, if anyone' },
  { name: 'collection', description: 'The collection of the record it is about, if any' },
  { name: 'item', description: 'The id of the record it is about, if any' },
  { name: 'created_at', description: 'When it was raised' },
  { name: 'nivaro_url', description: 'Link to the request in Nivaro' },
  { name: 'ticket_id', description: 'The request id' }
]

/** Variables a record template gets — fields only as the creating person can read them. */
export const RECORD_TEMPLATE_VARS: Array<{ name: string; description: string }> = [
  { name: 'label', description: 'The record label (as the creating person sees it)' },
  { name: 'collection', description: 'The collection name' },
  { name: 'collection_title', description: 'The collection title' },
  { name: 'item', description: 'The record id' },
  { name: 'fields', description: 'Field values the creating person can read, e.g. fields.status' },
  { name: 'nivaro_url', description: 'Link to the record in Nivaro' }
]

export function defaultTicketTitleTemplate(): string {
  return '{{ title }}'
}

export function defaultTicketBodyTemplate(): string {
  return `**{{ title }}**

Support request from {{ requester }}{% if category != '' %} · {{ category }}{% endif %}
Priority: {{ priority }} | Status: {{ status }}

{{ description }}

[Open in Nivaro]({{ nivaro_url }})
`
}

export function defaultRecordTitleTemplate(): string {
  return '{{ label }}'
}

export function defaultRecordBodyTemplate(): string {
  return `**{{ label }}** ({{ collection_title }})

[Open in Nivaro]({{ nivaro_url }})
`
}

export function defaultTitleTemplate(): string {
  return '[{{ severity }}] {{ title }}'
}

export function defaultBodyTemplate(): string {
  return `**{{ title }}**
{% if description and description != '' %}
{{ description }}
{% endif %}
Seen {{ total_hits }} times by {{ people_24h }} people in the last 24 hours ({{ hits_24h }} hits).
Severity: {{ severity }} | Source: {{ source }} | Status: {{ status }}
{% if route %}Route: \`{{ route }}\`
{% endif %}{% if environment %}Environment: {{ environment }}
{% endif %}{% if build %}Build: {{ build }}
{% endif %}First seen: {{ first_seen }} | Last seen: {{ last_seen }}
{% if recurrences > 0 %}Came back {{ recurrences }} times after being resolved.
{% endif %}{% if group_size > 1 %}Grouped with {{ group_size }} similar issues.
{% endif %}
{% if top_routes.size > 0 %}### Top routes
{% for r in top_routes %}- \`{{ r.route }}\` ({{ r.count }})
{% endfor %}{% endif %}
{% if details and details != '' %}### Details
{{ details | fenced }}
{% endif %}
[Open in Nivaro]({{ nivaro_url }})
`
}
