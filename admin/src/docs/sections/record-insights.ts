import type { DocSection } from '../types.js'

export const recordInsightsDocs: DocSection = {
  id: 'record-insights',
  label: 'Record Insights',
  content: [
    { type: 'h1', id: 'record-insights', text: 'Record Insights' },
    {
      type: 'p',
      text: 'Every saved record has an info button (ⓘ) in its header toolbar, next to the subscribe bell. It opens a popover that answers questions a record page normally cannot: who would hear if this record changed, what integrations have touched it, who has owned it as it moved through its workflow, what emails went out about it, and where it has come up in chat. Five tabs: Audience, Integrations, Owner history, Mail, and Chat.'
    },
    {
      type: 'note',
      text: 'The popover only appears on saved records, and every tab is permission-checked — you must be able to read the record to see any of it.'
    },
    { type: 'h2', id: 'record-insights-audience', text: 'Audience' },
    {
      type: 'p',
      text: 'The Audience tab lists one row per person who would be notified about changes to this record, with a badge explaining why. It combines three sources: current pipeline owners (with active delegates already applied), field watchers (both record-specific watches and collection-wide ones), and notification subscriptions on the collection.'
    },
    {
      type: 'ul',
      items: [
        'Owner rows carry an "Owner — notified on transitions" pill; watchers show "Chose to watch N fields" with the field list on hover; subscribers show one pill per subscription, such as "Subscribed to this record", "On \\"Approved\\" state changes", or "Area subscription (division, region)", each with its delivery cadence (instant, daily, or weekly).',
        'Subscriptions with dimension filters are evaluated against this record — a person subscribed only to Zone 2 does not appear on a Zone 3 record.',
        'Suspended and redacted users are excluded entirely, even when they are owners — they cannot receive anything, so listing them would mislead.'
      ]
    },
    { type: 'h2', id: 'record-insights-integrations', text: 'Integrations' },
    {
      type: 'p',
      text: 'The Integrations tab shows external system activity for the record: ERP/external-API submissions (the exact same data as the External requests chip, so the two can never disagree), recent webhook deliveries whose payload referenced this record, and any external identifiers found on the record itself — fields whose names look like external references (order numbers, requisition IDs, legacy system IDs) render as chips so you can see at a glance what other systems know this record as.'
    },
    { type: 'h2', id: 'record-insights-owner-history', text: 'Owner history' },
    {
      type: 'p',
      text: 'The Owner history tab walks the record’s workflow history as a series of stays: each state it entered, when it entered and left, who moved it, and who owned it in that state.'
    },
    {
      type: 'warn',
      text: 'Owners for past stays are an approximation, and the tab says so: each stay is resolved with today’s owner matrix configuration, because group membership over time is not snapshotted. A stay from six months ago lists whoever owns that state now, not necessarily who owned it then.'
    },
    { type: 'h2', id: 'record-insights-mail', text: 'Mail' },
    {
      type: 'p',
      text: 'The Mail tab lists the most recent emails (up to 50) sent about this record — subject, recipients, and a status pill per row; headers only, never bodies. Emails are matched two ways: senders that tag the record directly, and untagged emails whose subject contains the record’s friendly ID (its human identifier, like a workflow number), so third-party and older senders are caught too.'
    },
    {
      type: 'table',
      head: ['Pill', 'Meaning'],
      rows: [
        ['Sent', 'The mail server accepted the message.'],
        [
          'Failed',
          'Sending failed — the error reason is shown in red under the row, with the full text on hover.'
        ],
        [
          'In daily digest',
          'The recipient prefers a daily digest, so the message was held for it instead of sending immediately.'
        ],
        ['Not sent (test mode)', 'Mail test mode was on with no test recipient, so the message was discarded.']
      ]
    },
    { type: 'h2', id: 'record-insights-chat', text: 'Chat' },
    {
      type: 'p',
      text: 'The Chat tab surfaces team chat messages that mention this record’s ID outside its own record room — useful for finding side conversations about it. It relies on the record-rooms registry: the collection must have a registered chat room type, and the mention token is that registry’s match field (the record’s human ID). Only rooms you can already see are shown: direct messages appear as "a direct message" without revealing more, rooms you have no access to never appear, and deleted messages are excluded.'
    }
  ]
}
