import type { DocSection } from '../types.js'

export const liveOutsideDocs: DocSection = {
  id: 'live-outside',
  label: 'Live Beyond the App',
  content: [
    { type: 'h1', id: 'live-outside', text: 'Live beyond the app' },
    {
      type: 'p',
      text: 'Pages you open from outside the app keep up with the record too, without a reload.'
    },
    { type: 'h2', id: 'since-this-email', text: 'Since this email' },
    {
      type: 'p',
      text: 'Record links in the emails Nivaro sends carry the time the email went out. Open the record from one and a quiet line above the form says what happened since: “Since this email: moved to Approved · 2 fields changed”. It counts only fields you may read, and you can close it (the link then drops the time, so a reload stays quiet). The link carries a time only, never data.'
    },
    { type: 'h2', id: 'live-share-links', text: 'Share links and embedded feeds' },
    {
      type: 'ul',
      items: [
        'An open share link page (/share/…) updates in place when the shared record changes. The changed value fades in briefly; nothing scrolls or moves.',
        'An embedded list with data-live="true" re-reads its feed when what it shows changed.',
        'Both listen on a stream that carries only “something changed” — no ids, field names or values — and only when the page itself would now read differently. The page then re-reads through its usual link, as its creator, exactly as a reload would. Streams are limited per address, and the checks share the pushed-widget budget (`WIDGET_LIVE_MAX_PER_MIN`).'
      ]
    },
    { type: 'h2', id: 'outside-changes', text: 'Changes made outside the app' },
    {
      type: 'p',
      text: 'When a procedure, an import or a script announces what it wrote (`nivaro_announce_writes` or `nivaro_raw_writes`), open screens, the event stream, GraphQL subscriptions and live queries hear it like any save. Alert rules on the collection are checked again for the announced records.'
    },
    {
      type: 'ul',
      items: [
        'Webhooks and event flows can fire on these updates too, but only when you turn it on: on the webhook, tick “Also fire on changes made outside the app” under Events; on an event flow (After timing), turn on “Also run on changes made outside the app”. Off by default.',
        'Such a call carries the record as it is now, the changed field names, and no previous values or person (webhook origin `outside`; flow payload `outside: true`, `previousData` empty).',
        'An announcement of “many records changed” never fires per-record webhooks or flows.',
        "A flow or webhook never fires for its own write: a flow run’s writes are marked with the flow, and a procedure can mark its announcement with `@Source = 'flow:<id>'` or `'webhook:<id>'`.",
        'Field watches do not fire for these changes: they need the old value to tell you what it was.'
      ]
    }
  ]
}
