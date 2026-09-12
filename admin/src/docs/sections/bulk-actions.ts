import type { DocSection } from '../types'

export const bulkActionsGuide: DocSection = {
  id: 'bulk-actions',
  label: 'Bulk Actions',
  content: [
    { type: 'h1', id: 'bulk-actions', text: 'Bulk Actions' },
    {
      type: 'p',
      text: 'Bulk actions are admin-defined buttons offered over a selection — in the collection browser\'s selection bar and in a queue\'s selection pill — that apply one change to every selected record: On Hold, Remove Hold, Cancel, Uncancel and whatever else a collection needs. Each action is defined once per collection (Data Model → collection → Settings → Bulk actions) and each surface chooses which of the enabled actions it shows.'
    },
    { type: 'h3', text: 'What an action does' },
    {
      type: 'table',
      head: ['Kind', 'Behaviour'],
      rows: [
        [
          'Set fields',
          'Writes one or more fields on every record through the normal save path — field rules, validation, hooks and history all apply. A value can be text, a number, Yes / No, empty, or "the reason" (what the person typed into the reason box).'
        ],
        [
          'Run a transition',
          'Matched by transition LABEL per record against the collection\'s pipeline, so each record runs the transition valid from its own state — Uncancel\'s return-to-previous resolves per record. The transition\'s own conditions, required roles, requirements and actions are enforced exactly as a manual click; a record with no matching transition is skipped.'
        ]
      ]
    },
    { type: 'h3', text: 'Guard, access, reason' },
    {
      type: 'ul',
      items: [
        '"Only when" conditions are evaluated per record on its current values; records that don\'t match are counted as skipped, never failed (On Hold skips records already on hold).',
        '"Who can run it" — everyone with update permission on the collection, admins only, or specific roles. Enforced server-side on the run endpoint; the buttons only render for people who may run them.',
        '"Ask for a reason" makes the reason box required; the reason is stored as the change reason on every record\'s history (and the transition comment for transition kinds), so the Notes thread shows why.',
        'Confirm text appears in the popover above the Run button; "Destructive" renders the button in red.'
      ]
    },
    { type: 'h3', text: 'Per-surface enablement' },
    {
      type: 'table',
      head: ['Surface', 'Setting'],
      rows: [
        [
          'Collection browser',
          'Data Model → Settings → Collection Browser → "Bulk actions shown" (browser_config.bulk_actions — null = every action the viewer may run).'
        ],
        [
          'Queue',
          'Queue builder → Bulk actions → checklist across the queue\'s source collections (display_config.bulk_action_keys, entries are collection:key — null = all).'
        ],
        [
          'Extensions',
          'ctx.bulkActions.register({id, label, collections, access, require_reason, confirm, execute}) — appears alongside DB-defined actions on the same surfaces.'
        ]
      ]
    },
    { type: 'h3', text: 'Results' },
    {
      type: 'p',
      text: 'Every run reports done / skipped / failed with the first failures named per record (a transition whose conditions are not met, a blocked integration action, a validation error). Failed records stay selected so the run can be retried after fixing them; an activity row "bulk-action-execute" records the run and its reason.'
    },
    { type: 'h3', text: 'API' },
    {
      type: 'pre',
      code: `GET  /api/bulk-actions/available?collection=workflows   # what the caller may run
GET  /api/bulk-actions/catalog?collection=workflows     # every active action (editor pickers)
GET  /api/bulk-actions/transition-labels?collection=    # labels for the transition kind
POST /api/bulk-actions/run
{ "collection": "workflows", "key": "on-hold", "ids": [1, 2, 3], "reason": "Vendor dispute" }
→ { "data": { "succeeded": 2, "skipped": 1, "failed": 0, "errors": [], "skipped_items": ["3"] } }

# admin
GET/POST   /api/bulk-actions/defs?collection=
PATCH/DELETE /api/bulk-actions/defs/:id
{ "label": "On Hold", "key": "on-hold", "kind": "update_fields",
  "config": { "set": { "is_on_hold": true } },
  "guard": [{ "field": "is_on_hold", "op": "neq", "value": true }],
  "access": { "mode": "roles", "role_ids": ["…"] },
  "require_reason": true, "confirm_text": "…", "variant": "default" }`
    }
  ]
}
