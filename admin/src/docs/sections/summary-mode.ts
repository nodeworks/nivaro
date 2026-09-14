import type { DocSection } from '../types'

export const summaryMode: DocSection = {
  id: 'summary-mode',
  label: 'Summary Mode',
  content: [
    { type: 'h1', id: 'summary-mode', text: 'Summary Mode' },
    {
      type: 'p',
      text: 'Summary mode is the record form rendered as a read-only presentation: the active grouped layout as section cards and definition grids, child tables instead of editable grids, related records as labels and drill links. Nothing on the record itself can be changed until the viewer switches to Edit — but the Notes and Tasks slots stay live, so a reviewer can comment on or assign work from the summary without leaving it.'
    },
    { type: 'h3', text: 'Switching modes' },
    {
      type: 'p',
      text: 'When the collection has Summary mode enabled, the record header carries a Summary / Edit segmented control with the active side filled. The choice lasts for the current visit only — nothing is stored per user; every open runs the opening-mode rules again. New records always open in Edit. The right-hand summary rail collapses while in Summary mode and returns when switching back.'
    },
    { type: 'h3', text: 'The Summary layout' },
    {
      type: 'p',
      text: 'What Summary mode shows is a layout of type "summary" (Data Model → collection → Layouts → layout type). It renders the same way a read-only detail sheet does — section cards, definition grids, child tables, the header band and hide-empty settings — and it carries its own groups and field assignments, so the summary can differ from the edit form: fewer fields, a different order, a header band with the identity fields. Start one with "Clone as Summary" on the grouped layout, which copies every group, assignment and override, then trim. A collection without a summary layout renders its grouped layout read-only, which is the pre-layout behaviour. Each section has a read-view width (Data Model → Layout → group settings → "Summary / read-view width": auto, full, half or one third) — the board is six tracks wide, so two half sections sit side by side and a lines grid takes the row; auto is half for a short fact list and full when the section holds a grid or widget. Child grids with no rows and links with nothing linked count as empty, so an empty Files section disappears. Widget slots with nothing to show (an empty rollup, a review list with no rows) are hidden in Summary mode, and a section left with nothing collapses with them. Data-integrity findings do not render as a banner in Summary mode; the affected fields (or child grids) carry an amber mark whose tooltip lists the issues.'
    },
    { type: 'h3', text: 'Which mode a record opens in' },
    {
      type: 'p',
      text: 'Data Model → collection → Settings → Form UX. Turn on "Summary mode" to show the switch, then set the default (Edit or Summary) and any number of rules. A rule combines a role list and a state test: "when role is X and state is / is not [states] → open in Summary|Edit". Leave roles empty to match any role, states empty to match any state. "No state yet" matches a record that has no pipeline instance. Rules run top to bottom and the first match wins; when none match the default applies.'
    },
    {
      type: 'pre',
      code: `PATCH /api/collections/workflows
{
  "read_mode_toggle": true,
  "summary_mode_rules": {
    "default": "summary",
    "rules": [
      { "states": ["started", "__none__"], "states_op": "in", "mode": "edit" }
    ]
  }
}`
    },
    {
      type: 'note',
      text: 'The example above is the typical approval-flow setup: a record is editable while it is still being drafted (started, or no pipeline instance yet) and opens as a summary once it has moved on. Anyone can still flip to Edit — the rules pick the first impression, permissions decide what can actually be saved.'
    },
    {
      type: 'table',
      head: ['Field', 'Meaning'],
      rows: [
        ['default', "'edit' or 'summary' — used when no rule matches."],
        ['rules[].roles', 'Role ids (uuid). Empty or omitted = any role.'],
        [
          'rules[].states',
          "Pipeline state keys, plus the sentinel '__none__' for records with no instance. Empty or omitted = any state."
        ],
        ['rules[].states_op', "'in' (default) or 'not_in' — inverts the state test."],
        ['rules[].mode', "'edit' or 'summary' — the mode to open in when the rule matches."]
      ]
    },
    {
      type: 'p',
      text: 'GET /api/collections/:collection returns the normalized object (never null). The server validates on PATCH: at most 20 rules, 50 roles or states per rule, uuid-shaped roles, key-shaped states. Storing the empty default clears the column.'
    }
  ]
}
