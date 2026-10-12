import type { DocSection } from '../types.js'

export const collabLiveRecords: DocSection = {
  id: 'live-records',
  label: 'Live Records',
  content: [
    { type: 'h1', id: 'live-records', text: 'Live Records' },
    {
      type: 'p',
      text: 'An open record keeps up with what other people and automations do to it, without a reload. The server only says THAT something changed (record id and field names, never values); each panel then re-reads through its own permission-checked request, so nobody sees a value they could not already open.'
    },
    { type: 'h3', id: 'live-records-what', text: 'What updates on its own' },
    {
      type: 'table',
      head: ['When', 'What you see'],
      rows: [
        [
          'Someone else moves the record',
          'The state badge, pipeline panel and transition buttons refresh, and a toast says who moved it where ("Kim moved this to Finance Review").'
        ],
        [
          'Owners change (owner matrix, delegation, out of office, team membership)',
          'The owners chip and approval chain refresh.'
        ],
        [
          'Someone else deletes the record',
          'A banner says the record was deleted and saving is turned off. Administrators, and whoever deleted it, also see who and when, and get a Restore button when they have create permission.'
        ],
        [
          'Your access changes (role, policy, row filter, User Scope, subtree grant)',
          'The page re-reads the record as you. If you can no longer see it, a banner says so and saving is turned off; the form stays on screen so you can copy what you need.'
        ],
        [
          'An addendum is created, submitted, approved or rejected',
          'The record’s addendum view refreshes, and list/queue addendum badges follow.'
        ],
        [
          'Comments or tasks are added or closed',
          'The record’s comments and tasks refresh; open-task counts on collection lists and queues, and comment counts on grid rows, update in place.'
        ],
        [
          'A partner push lands, fails or is acknowledged',
          'The Integrations chip and its dialog refresh.'
        ],
        [
          'The after-save integrity check finishes',
          'The integrity banner (or the Summary-mode field marks) refresh at once.'
        ],
        [
          'Fields change while you are in Summary mode',
          'The values refresh and the ones that moved briefly highlight.'
        ],
        ['The history panel is open', 'New changes appear at the top, marked New.'],
        [
          'A flow run is working on the record',
          'A banner names the flow ("Automation is updating this record") until the run ends.'
        ],
        [
          'The same record is open with unsaved changes in another tab of your browser',
          'A banner warns you before you edit here too, with a button that asks the other tab to come forward (browsers may only flag its title).'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Your own saves never echo back as "someone else": writes this tab sent are recognised for a few seconds and skipped.'
    },
    { type: 'h3', id: 'live-records-events', text: 'Socket events' },
    {
      type: 'table',
      head: ['Event', 'Room', 'Payload'],
      rows: [
        [
          '`collection:update`',
          '`collection:<name>`',
          '`{collection, item, action?, changed_fields?}`. A notice with no `action` whose fields are all `$` names (`$state`, `$addendums`, `$comments`, `$tasks`, `$integrations`) says a related surface moved, not the record’s columns.'
        ],
        ['`record:integrity`', '`record:<collection>:<id>`', '`{collection, item}`'],
        [
          '`record:automation`',
          '`record:<collection>:<id>`',
          '`{collection, item, flow_id, flow_name, state: start|end}`'
        ],
        [
          '`owners:changed`',
          'the tenant (cloud: `t:<tenant>:all`; self-hosted: every socket) — coalesced 5 s, at most one per 15 s',
          '`{at}`'
        ],
        [
          '`access:changed`',
          'the tenant for an administrator’s access write; only the person’s own sockets for their own scope pick — coalesced',
          '`{at}`'
        ]
      ]
    },
    {
      type: 'p',
      text: '`GET /api/trash/record?collection=&item=` answers the latest deletion of one record (`deleted_at`, `deleted_by_name`, `can_restore`, and `trash_id` only when you may restore it) — to an unrestricted administrator or to the person who deleted it. Everyone else gets `{ "data": null }`, the same answer as "not deleted": the trash snapshot cannot be checked against your row filter or User Scopes.'
    },
    { type: 'h3', id: 'live-records-hooks', text: 'Building a live panel (shared hooks)' },
    {
      type: 'pre',
      code: `import { useLiveRecord, useLiveRecordQueries, useLiveCollection,
  useLiveRecordEvent, useLiveEvent, batchTouches, LIVE_ASPECTS } from '@nivaro/shared'

// Refetch react-query keys when this record changes (someone else's write):
useLiveRecordQueries('orders', id, [['my-panel', 'orders', id]], { client: queryClient })

// Custom reaction — events inside 250 ms arrive as one batch:
useLiveRecord('orders', id, (batch) => {
  if (batch.deleted) return showGone()
  if (batchTouches(batch, LIVE_ASPECTS.state)) refetchState()
  if (!batch.aspectsOnly) refetchRecord()
})

// A whole list:
useLiveCollection('orders', (batch) => refreshRows(batch.ids), {
  match: (ev) => visibleIds.has(String(ev.item))
})

// A record-room event:
useLiveRecordEvent('record:integrity', 'orders', id, () => refetchIntegrity())`
    },
    {
      type: 'ul',
      items: [
        'Handlers live in a ref — pass inline arrows. Options: `debounceMs` (default 250; 0 = per event), `includeOwn`, `match`, `enabled`.',
        'A batch reports `ids`, `changedFields` (null = unknown, treat as everything), `aspectsOnly`, `created`, `deleted`, `own`.',
        'Without a host realtime adapter the collection hooks do nothing and the panel behaves as before. Hosts whose record room rides a separate socket forward its events with `relayLiveEvent(event, payload)`.',
        'Never trust a payload value — re-read through your own permission-checked query.'
      ]
    }
  ]
}
