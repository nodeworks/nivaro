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
        ['recent-activity', 'Latest activity entries, optionally scoped to a collection']
      ]
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
