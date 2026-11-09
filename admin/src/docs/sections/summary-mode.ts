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
      text: 'Data Model → collection → Settings → Form UX. Turn on "Summary mode" to show the switch, then set the default (Edit or Summary) and any number of rules. A rule combines a role list, a state test and conditions on the record\u2019s own values: "when role is X, state is / is not [states] and On Hold is true → open in Summary|Edit". Leave roles empty to match any role, states empty to match any state. "No state yet" matches a record that has no pipeline instance. Rules run top to bottom and the first match wins; when none match the default applies.'
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
        [
          'rules[].conditions',
          "Record values that must ALL hold: [{field, op, value}] with the row-highlight ops (eq, neq, gt, gte, lt, lte, contains, null, nnull). A value may name another field ('{{budget}} * 0.9'). Omitted = any record. At most 10 per rule."
        ],
        ['rules[].mode', "'edit' or 'summary' — the mode to open in when the rule matches."]
      ]
    },
    {
      type: 'p',
      text: 'GET /api/collections/:collection returns the normalized object (never null). The server validates on PATCH: at most 20 rules, 50 roles or states per rule, uuid-shaped roles, key-shaped states. Storing the empty default clears the column.'
    },
    { type: 'h3', id: 'summary-mode-edit-lock', text: 'Edit lock while a record waits' },
    {
      type: 'p',
      text: 'The opening mode is only a first impression. `edit_lock` in the same object is enforced: while the record\u2019s open pipeline instance sits in one of `states`, only the record\u2019s creator, the people who own the current step (owner groups, instance owners, delegates, the owner fallback) and administrators may change it — or create, change or delete a row of a collection listed in `children` that points at it. Everyone else gets 403 `EDIT_LOCKED` with a sentence naming the step, and the form opens read-only for them: GET /api/pipelines/instance/:collection/:item returns `edit_lock` {locked, allowed, message} (null when nothing is locked for the caller). Children are named, never inferred — notes, forecasts and queue rows point at the record too, and other people write those. Writes the engine makes on its own (flows, transition actions, approved addendums, scheduled jobs, imports) are not judged.'
    },
    {
      type: 'pre',
      code: `"edit_lock": {
  "states": ["waiting_on_manager_approval", "waiting_on_vp_approval"],
  "children": ["workflow_line_items"]
}`
    },
    { type: 'h3', id: 'summary-mode-admin-only', text: 'Admin-only steps (post-approval)' },
    {
      type: 'p',
      text: '`edit_lock.admin_only` is a stricter tier for steps after approval: in its `states` only administrators change the record or the rows of its `children`. Not even the creator or the step\u2019s owners can. `open_fields` (field names) and `open_children` (collection names) stay writable for everyone who may normally write them, for example a PO number that arrives after approval. `transitions` lists transition ids that only administrators may run while the record is at one of those states; the Pipeline panel and the row menu hide them, and the move route and bulk transitions refuse them with 403 `ADMIN_ONLY_TRANSITION`. A completed record is judged by its latest instance, so a finished state can be listed too. Item actions and outbound pushes skip this tier. When `open_fields` is not empty the person-held edit lock is still granted, so the open fields can be edited. Refusals read \u201cThis record is at {step} \u2014 only administrators can change its fields. Use Request help to ask for a change.\u201d When the record still offers the person a move from that step (the record panel\u2019s actions, which this tier does not lock), the sentence says so instead: \u201cThis record is at {step} \u2014 only administrators can change its fields. You can still use the actions above; use Request help to ask for any other change.\u201d The form opens read-only with that sentence, and every saved record has a Request help button beside Save.'
    },
    {
      type: 'pre',
      code: `"edit_lock": {
  "states": ["waiting_on_manager_approval"],
  "children": ["workflow_line_items"],
  "admin_only": {
    "states": ["approved", "ordered"],
    "transitions": ["<transition uuid>"],
    "open_fields": ["po_number"],
    "open_children": ["workflow_notes"]
  }
}`
    },
    {
      type: 'p',
      text: 'The move-requirements dialog is the one exception: its PATCH carries the header `x-nivaro-requirements-for: <transition id>`, and the fields that move declares as requirements are let through both lock tiers and the admin-only field option, but only when the caller may run that move now on that record (its conditions are still evaluated). The SDK sends it through `withHeaders` on a command.'
    },
    { type: 'h3', id: 'summary-mode-switch', text: 'Switching a yes/no field from Summary view' },
    {
      type: 'p',
      text: 'A yes/no (boolean) field can be flipped straight from Summary view, without opening Edit. In the layout editor, select the field and turn on **Switch it from Summary view** (Rules tab). Summary view then shows a switch instead of Yes/No text. Flipping it saves that one field as the reader: their access, the edit lock and the field\u2019s validation are checked as for any save, and a refusal shows why. Off by default; it is a placement option (`summary_toggle: true` in the placement overrides), so each form decides.'
    }
  ]
}
