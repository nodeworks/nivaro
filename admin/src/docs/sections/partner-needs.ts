import type { DocSection } from '../types.js'

export const partnerNeedsDocs: DocSection = {
  id: 'partner-needs',
  label: 'Partner Needs on the Form',
  content: [
    { type: 'h1', id: 'partner-needs', text: 'Partner Needs on the Form' },
    {
      type: 'p',
      text: 'A step that sends a record to a partner system (an ERP, a warehouse) can only send what the record holds. When a field it needs is empty, the step stops at the very end. With this on, those fields carry a small **Needed by <partner>** badge from the start, so people fill them while they are on the record anyway.'
    },
    { type: 'h2', id: 'partner-needs-form', text: 'What people see' },
    {
      type: 'ul',
      items: [
        '**Needed by Acme ERP** beside a field’s label while the field is empty. Pointing at it says which step sends it. Filling the field clears the badge at once.',
        'Badges follow what the form holds **now**, unsaved changes included. When the record’s values decide which partner gets the record (its warehouse, its type), changing that value moves the badges to the other partner’s fields, before saving.',
        'When the field that picks the partner is still empty, there are no partner badges. That field shows a quiet line instead: “Pick a Warehouse to see what it needs.” The badges appear as soon as it is picked.',
        'Lines are judged one by one. An empty cell a partner needs shows the partner’s name at its edge, on the lines that go to that partner only. Two lines of one record can name different partners.',
        'Only fields the person may read are named. Read-only, calculated and generated fields are never badged.'
      ]
    },
    { type: 'h2', id: 'partner-needs-which', text: 'Which steps count' },
    {
      type: 'ul',
      items: [
        'Partner pushes on steps out of the record’s current step and out of every step it can reach by moving forward (to a step with a higher order). A new record starts at its pipeline’s first step. When the pipeline’s steps have no order, only the next steps count. Steps a person presses and automatic steps both count.',
        'A push counts only when its own conditions pass for the current values: the lookup that must find a row (`skip_when_empty`), the any-of check (`skip_unless_any`) and the guard rules. These are the same checks the push itself runs.',
        'What a push needs is read from its payload template: a value it always sends with no fallback. A value with a fallback, one sent only when it is not empty, or one inside an `if` in Liquid is not badged.'
      ]
    },
    { type: 'h2', id: 'partner-needs-setting', text: 'Turning it on' },
    {
      type: 'p',
      text: '**Data Model → Settings → Form UX → Partner needs on the form**, per collection, off by default. Stored as `browser_config.partner_badges` on the collection (no migration):'
    },
    {
      type: 'pre',
      code: `PATCH /api/collections/stock_requests
{ "browser_config": { "partner_badges": true } }`
    },
    { type: 'h2', id: 'partner-needs-api', text: 'API' },
    {
      type: 'pre',
      code: `POST /api/partner-needs/stock_requests
{ "item": "1042",                        // null for a new record
  "values": { "warehouse": 5 },          // the form's current values
  "lines": { "stock_request_lines.request": [
      { "key": "7811", "values": { "quantity": 2 } },
      { "key": "pending:0", "values": { "quantity": 1 } } ] } }
→ { data: {
    enabled: true, depth: "forward", state: { key: "approved", … },
    fields: { ship_to: { partners: ["Acme ERP"], steps: ["Send to warehouse"] } },
    hints: {},
    lines: { "stock_request_lines.request": { rows: {
      "7811": { item: { partners: ["Acme ERP"], steps: ["Send to warehouse"] } } } } },
    inputs: { record: [ … ], lines: { … } } } }`
    },
    {
      type: 'p',
      text: 'The caller must be able to read the record (or create in the collection, for a new one). `inputs` names the values the answer depends on: the form sends only those back, about 0.6 s after typing stops, and reuses an answer for the same values. It is a read: nothing is rendered, sent or written.'
    }
  ]
}
