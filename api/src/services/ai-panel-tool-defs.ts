import type Anthropic from '@anthropic-ai/sdk'

/** Tool definitions for ai-panel-tools.ts, apart so ai-chat.ts can list them without loading the executors. */
export const PANEL_TOOL_NAMES = new Set(['ask_choice', 'saved_view', 'compare'])

export const PANEL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'ask_choice',
    description:
      'Ask the person to pick when the question is genuinely ambiguous ("which zone?", "this year or the funding year?") instead of guessing or writing the question as prose. Give EITHER `options` (2-8 short interpretations, no data values) OR `source`: {collection, field} lists the distinct values of a column, {collection, search?, filter?} lists matching records — both are read with the asker\'s access. After calling it, write ONE short sentence and stop: the person picks inline and the answer continues from their pick. Never use it when a reasonable default exists — answer with the default and say which you used.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question, e.g. "Which zone do you mean?"' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short labels for the interpretations (max 8).'
        },
        source: {
          type: 'object',
          properties: {
            collection: { type: 'string' },
            field: {
              type: 'string',
              description: 'Plain column whose distinct values are the choices.'
            },
            search: { type: 'string' },
            filter: { type: 'object', description: 'Same shape as query_items filter.' },
            limit: { type: 'number', description: 'Max 12.' }
          },
          required: ['collection']
        }
      },
      required: ['question']
    }
  },
  {
    name: 'saved_view',
    description:
      'Use a saved view the asker can see (their own, shared ones and their role\'s) — "my late IRs view", "the Zone 1 view". Without `name` it lists the visible views (optionally for one `collection`). With `name` it returns the view\'s collection, the filter it applies (the same shape query_items / aggregate take, so you can add to it or group it), and the total plus the first rows, read with the asker\'s access. A view whose filter touches a field the asker cannot read is refused.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The view name as the person said it.' },
        collection: { type: 'string', description: 'Narrow the list / the name match.' },
        limit: { type: 'number', description: 'Rows to return, max 25 (default 10).' }
      }
    }
  },
  {
    name: 'compare',
    description:
      'Compare two things side by side and get back values plus deltas — use it for "Q1 vs Q2 spend by zone", "this year vs last year", "this request vs the last three like it". mode "sets": the same aggregate (collection, op, field?, group_by?) over two filters `a` and `b` ({label, filter}); each side is the aggregate tool, so the same access rules apply. mode "records": two to four records ({collection, id}) shown field by field with the differing fields first (only fields the asker may read). Present the result as a table of values and deltas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['sets', 'records'] },
        collection: { type: 'string' },
        op: { type: 'string', enum: ['count', 'sum', 'avg', 'min', 'max'] },
        field: { type: 'string' },
        group_by: { type: 'string' },
        a: {
          type: 'object',
          properties: { label: { type: 'string' }, filter: { type: 'object' } }
        },
        b: {
          type: 'object',
          properties: { label: { type: 'string' }, filter: { type: 'object' } }
        },
        records: {
          type: 'array',
          items: {
            type: 'object',
            properties: { collection: { type: 'string' }, id: { type: 'string' } },
            required: ['collection', 'id']
          }
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit records mode to these fields.'
        }
      },
      required: ['mode']
    }
  }
]
