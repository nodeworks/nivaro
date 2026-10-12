import type Anthropic from '@anthropic-ai/sdk'

/** Tool definitions for ai-context-tools.ts, apart so ai-chat.ts can list them without loading the executors. */
export const CONTEXT_TOOL_NAMES = new Set(['report_data', 'config_lookup', 'my_team'])

export const CONTEXT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'report_data',
    description:
      'Re-run a Report Studio report\'s widgets as the asker, with the date range and filters they have on screen (given under "Context from the page"). Without widget_id: every widget\'s current figures (value, change, top of each series). With widget_id: that widget\'s whole series plus, when it has two or more points, the biggest movers and the rows behind the current and previous windows. Use for "why did March dip", "which zone drives the overrun", "what does this report say".',
    input_schema: {
      type: 'object' as const,
      properties: {
        report_id: { type: 'string' },
        widget_id: { type: 'string', description: 'One widget; omit for all of them.' },
        date_range: {
          type: 'object',
          description:
            '{"preset": "this_month"|"last_30_days"|"last_3_months"|"last_6_months"|"last_12_months"|"ytd"|"custom", "start"?: "YYYY-MM-DD", "end"?: "YYYY-MM-DD"} — the one on screen unless the question names another.'
        },
        entity_filters: {
          type: 'array',
          description: 'The report filters on screen: [{"field": "...", "values": [...]}].',
          items: { type: 'object' }
        }
      },
      required: ['report_id']
    }
  },
  {
    name: 'config_lookup',
    description:
      'Administrators only; read only. How this instance is configured. mode "field_usage": every rule, flow, layout, queue, owner filter, report widget, import template and saved view that uses collection.field ("which rules, flows and layouts use workflows.amount"). mode "field_lock": every setting that makes collection.field read-only (field settings, layout lock conditions, role-locked sections, lock rules, locking pipeline states). mode "owners": who owns / approves records of a collection in a pipeline state — give `state` (key or label) and `values` (dimension field or label → value, e.g. {"zone": "Zone 3", "amount": 50000}) to see which owner group wins and its people. mode "automations": the rules, flows, webhooks, SLA rules, alerts, field watches and code hooks that act on a collection.',
    input_schema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['field_usage', 'field_lock', 'owners', 'automations'] },
        collection: { type: 'string' },
        field: { type: 'string', description: 'A column name, for field_usage and field_lock.' },
        state: { type: 'string', description: 'A pipeline state key or label, for owners.' },
        values: {
          type: 'object',
          description: 'For owners: the record to match the owner matrix against.'
        }
      },
      required: ['mode', 'collection']
    }
  },
  {
    name: 'my_team',
    description:
      'Managers only: the asker\'s own direct reports (never anyone else\'s). view "workload": open records per person with SLA breaches, warnings, stuck records and the oldest ones; "tasks": open and overdue tasks per person; "coverage": who is out or about to be and who covers for them; "week": completions, send-backs and new SLA breaches over the last 7 days. Records the asker cannot open are only counted, never named.',
    input_schema: {
      type: 'object' as const,
      properties: {
        view: { type: 'string', enum: ['workload', 'tasks', 'coverage', 'week'] }
      },
      required: ['view']
    }
  }
]
