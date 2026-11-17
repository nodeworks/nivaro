import { Liquid } from 'liquidjs'

// Issue text goes to GitLab as markdown, so output is NOT html-escaped.
const engine = new Liquid({ outputEscape: undefined, strictVariables: false, strictFilters: false })
const MAX_OUTPUT = 60000

export const TEMPLATE_VARS: Array<{ name: string; description: string }> = [
  { name: 'title', description: 'The Nivaro issue title' },
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
    out = await engine.parseAndRender(tpl, vars)
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : 'unknown problem'
    throw new Error(`The template could not be rendered: ${msg}`)
  }
  return out.length > MAX_OUTPUT ? out.slice(0, MAX_OUTPUT) : out
}

export function defaultTitleTemplate(): string {
  return '[{{ severity }}] {{ title }}'
}

export function defaultBodyTemplate(): string {
  return `**{{ title }}**

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
\`\`\`
{{ details }}
\`\`\`
{% endif %}
[Open in Nivaro]({{ nivaro_url }})
`
}
