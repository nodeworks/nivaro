import type Anthropic from '@anthropic-ai/sdk'

/** Tool definitions for ai-watch-tools.ts, apart so ai-chat.ts can list them without loading the executors. */
export const WATCH_TOOL_NAMES = new Set(['my_watches', 'past_state'])

export const WATCH_TOOLS: Anthropic.Tool[] = [
  {
    name: 'my_watches',
    description:
      'The numbers the asker is watching (set up with "Tell me when this goes over…" under an answer): each with its current value, change since yesterday, threshold, state and last alert. Use for "what am I watching", "is anything I watch close to its limit".',
    input_schema: { type: 'object' as const, properties: {} }
  },
  {
    name: 'past_state',
    description:
      'Look at a record in the past from its revision and pipeline history. mode "as_of": the record as it stood on a date (as_of = YYYY-MM-DD, taken as the end of that day). mode "changes": when a field changed, from what to what, and who changed it (give `field`; omit it to list which fields changed and when). mode "time_in_state": how long it sat in each pipeline state. Only the newest 100 history entries are read; the result says when the history is cut short. Fields you may not read are never returned.',
    input_schema: {
      type: 'object' as const,
      properties: {
        collection: { type: 'string' },
        id: {
          type: 'string',
          description: 'The record id (the internal id, not the friendly id).'
        },
        mode: { type: 'string', enum: ['as_of', 'changes', 'time_in_state'] },
        as_of: { type: 'string', description: 'YYYY-MM-DD, for mode as_of.' },
        field: { type: 'string', description: 'A column name, for mode changes.' }
      },
      required: ['collection', 'id', 'mode']
    }
  }
]
