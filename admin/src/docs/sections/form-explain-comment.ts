import type { DocSection } from '../types.js'

/** #3228 hidden sections explain themselves · #3232 comment on a single field. */
export const formHiddenAndFieldComments: DocSection = {
  id: 'form-hidden-and-field-comments',
  label: 'Hidden sections and field comments',
  audience: 'all',
  content: [
    {
      type: 'h1',
      id: 'form-hidden-and-field-comments',
      text: 'Hidden sections and field comments'
    },
    { type: 'h2', id: 'hidden-sections-explain', text: 'Why a section is hidden' },
    {
      type: 'p',
      text: 'A step, tab or section with a show-when rule ("Only when" in the layout editor) used to vanish while the record did not match. It now leaves one quiet line in its place, written from the rule in plain words: "Unit Selection shows when Type is Capital". Field labels and choice labels are used, never keys or stored values; yes/no rules read "shows when the record is sparing".'
    },
    {
      type: 'ul',
      items: [
        '“Show anyway (read-only)” opens the hidden part with every field locked; the lock tip names the rule. “Hide again” folds it away. Nothing is saved: the next visit starts hidden again.',
        'On the edit form the line sits under the step bar or tab strip; in Summary mode it sits above the section cards.',
        'Only rule-hidden parts are named. A section hidden for your role never reaches the browser, and a section whose fields you may not read is never named or revealed, so the line cannot confirm what permissions hide.',
        'The layout editor canvas shows the same line (unless “Show hidden” is on, which already draws hidden parts faint).'
      ]
    },
    {
      type: 'p',
      text: "Layout editor → select the step → “As a step” → “Say why it is hidden” (on by default). Off keeps the old behaviour for that step: it vanishes without a word. Stored in the layout's `conditions.quiet_hidden_sections` (a list of section keys), beside `lazy_sections`."
    },
    { type: 'divider' },
    { type: 'h2', id: 'field-comments', text: 'Comment on one field' },
    {
      type: 'p',
      text: 'Pointing at (or tabbing into) a field on a saved record shows a small speech-bubble beside its label. It opens a popover with that field\'s comments and a composer with the usual @mention autocomplete (people, roles, teams, @owners). The comment is a normal record comment tagged with the field: it also appears in the record\'s Comments as "on Amount", and the tag jumps to the field.'
    },
    {
      type: 'ul',
      items: [
        'A field with open comments shows a count beside its label at all times.',
        '“Resolve” marks a field comment done (it leaves the count but stays in the thread); “Reopen” brings it back.',
        'Mentioned people get the normal mention notification ("You were mentioned on Amount") only when they may open the record and read that field, judged as each of them (row filters, User Scopes, field permissions). The mention is still recorded for the others.',
        "The notification link opens the record with `?field=<name>`: the form switches to the field's step or tab (Summary flips to Edit), scrolls to it, flashes it and opens its comments. The link icon in the popover copies the same link.",
        "Field comments follow the layout's comments switch: a layout with comments turned off shows no field comment buttons."
      ]
    },
    {
      type: 'pre',
      code: `POST /api/comments
{ "collection": "orders", "item": "42", "text": "@sam is this net or gross?",
  "field": "amount", "field_label": "Order amount" }
// 400 BAD_FIELD — not a plain field name
// 404 FIELD_NOT_FOUND — no such field, or one the writer may not read
// 409 FIELD_COMMENTS_UNAVAILABLE — the database has no field column yet (migration 521)

GET /api/comments?collection=orders&item=42
// every comment carries "field" (null = whole record) and "resolved_at"

POST /api/comments/:id/resolve   { "resolved": true | false }`
    },
    {
      type: 'note',
      text: 'Columns `nivaro_comments.field`, `resolved_at`, `resolved_by` (migration 521, nullable). Without them the comments routes work as before and field comments answer 409.'
    }
  ]
}
