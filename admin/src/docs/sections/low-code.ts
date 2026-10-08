import type { DocSection } from '../types.js'

export const lowCodePageBuilder: DocSection = {
  id: 'page-builder',
  label: 'Page Builder',
  content: [
    { type: 'h1', id: 'page-builder', text: 'Page Builder' },
    {
      type: 'p',
      text: 'Build internal pages without code: compose widgets on a grid and publish to a slug. Pages are stored in `nivaro_pages`, managed at /pages-admin, edited in the drag-and-drop builder at /pages-admin/:id/edit, and viewed at /p/:slug.'
    },
    { type: 'h3', text: 'Widgets' },
    {
      type: 'table',
      head: ['Widget', 'Renders'],
      rows: [
        ['table', 'A filtered, column-picked view of any collection'],
        ['kpi', 'A single aggregate number (count/sum/avg) with label'],
        ['markdown', 'Rich text / documentation blocks'],
        ['iframe', 'An embedded external page'],
        ['recent-activity', 'Latest activity entries, optionally scoped to a collection'],
        [
          'query',
          'A custom query rendered as a table, with optional filters, stat strip, row actions and drill sheets'
        ],
        ['matrix', 'A tuple-scoped value grid over a target collection'],
        ['record-grid', 'An editable grid over a collection, with scope pickers and month sets']
      ]
    },
    { type: 'h3', text: 'Drill sheets' },
    {
      type: 'p',
      text: "A query widget's `row_click.sheet` (and each `row_actions[].sheet`) takes `title`, `width`, `tabs` (each a nested query view or a matrix), an optional `header` — `{ query_slug, params, stats }`, a query of its own rendered as stat tiles above the tabs with the same `$row.` / `$param.` / `$filters.` tokens as a tab — and `initial_tab`, the zero-based tab to open first."
    },
    {
      type: 'pre',
      code: "row_actions: [{ label: 'View budget', sheet: { title: '{{project_id}}', header: { query_slug: 'project-health', params: { projects: '$row.project_id' }, stats: [{ label: 'Remaining', field: 'remaining', format: 'currency' }] }, initial_tab: 1, tabs: [ … ] } }]"
    },
    { type: 'h3', text: 'Query widget stats' },
    {
      type: 'p',
      text: "A query widget can show a strip of stat tiles above its table. Each `stats` entry is computed over the query's rows (or its own query) and takes the keys below. Every formula counts only rows that hold all of its operands: a ratio over partially reported rows reads the reporting rows alone, and a sum formula likewise skips a row missing any operand."
    },
    {
      type: 'table',
      head: ['Key', 'Meaning'],
      rows: [
        ['label', 'Tile title'],
        ['field', 'Sum of this result column'],
        ['query', 'An independent stat: `{slug, param_from, value_field, label_field}`'],
        [
          'field_subtract',
          'Delta stat: `field` minus this column, shown with a leading + when positive'
        ],
        ['formula', '`{{a}} / {{b}}` arithmetic over the summed columns'],
        [
          'format',
          'currency, number, percent (0-100 scale, up to 1 decimal), date or text. Date and text render quieter and take the first row value only for a tile with a `query`; a row-field tile with these formats shows the empty label'
        ],
        ['empty_label', 'Shown when the value is null'],
        [
          'coverage',
          "Plural noun for a table row, for example `projects`. When only some rows report the figure, a quiet 'N of M projects' line appears under the value; when none do, the tile shows `empty_label`"
        ],
        ['accent / accent_negative', 'Colour roles for the tile value and for a negative delta']
      ]
    },
    {
      type: 'pre',
      code: "{ label: '% Remaining', formula: '{{remaining}} / {{budget}} * 100', format: 'percent', empty_label: 'no data yet', coverage: 'projects' }"
    },
    {
      type: 'p',
      text: 'Two query table column keys complement this: `empty_label` sets what a null cell prints (an empty string leaves it blank), and `max_width` caps a text column at that many pixels with an ellipsis.'
    },
    {
      type: 'note',
      text: "Widget data is fetched server-side through a widget-data endpoint that enforces the viewer's permissions — a page can never show a user rows they could not read through the API."
    }
  ]
}

export const lowCodeRuleBuilder: DocSection = {
  id: 'rule-builder',
  label: 'Rule Builder UI',
  content: [
    { type: 'h1', id: 'rule-builder', text: 'Rule Builder UI' },
    {
      type: 'p',
      text: 'The Rule editor gains a structured builder: conditions are composed with field/operator/value rows (AND/OR groups) and actions are configured with typed forms instead of raw JSON. A JSON toggle exposes the underlying definition for power users — both views stay in sync.'
    },
    {
      type: 'ul',
      items: [
        "Condition rows offer the collection's fields in a combobox with operators appropriate to the field type.",
        'Action forms cover notifications, webhooks, mail, and cross-collection writes with inline {{field}} template hints.',
        'Switch to JSON at any time; invalid JSON blocks saving with an inline error.'
      ]
    }
  ]
}

export const lowCodeFormulaBuilder: DocSection = {
  id: 'formula-builder',
  label: 'Formula Builder',
  content: [
    { type: 'h1', id: 'formula-builder', text: 'Formula Builder' },
    {
      type: 'p',
      text: 'Computed field formulas can be built visually in the Table Editor: a token-chip editor where fields, functions, and operators are inserted as chips with autocomplete, eliminating syntax errors. A Builder | Raw toggle switches between chips and the plain formula string.'
    },
    {
      type: 'ul',
      items: [
        "Field chips are picked from the collection's fields; function chips (CONCAT, UPPER, TODAY, …) show their signatures.",
        'The raw view always reflects the chips and vice versa — edits in either survive the toggle.',
        'Validation runs live, with the first error highlighted on the offending chip.'
      ]
    }
  ]
}
