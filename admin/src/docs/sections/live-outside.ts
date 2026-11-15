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
    { type: 'h2', id: 'approval-links-live', text: 'Approve and Reject from email' },
    {
      type: 'p',
      text: 'Turn on “Approve / Reject in emails” at the top of the Approvals page and each approval request email carries an Approve and a Reject button, signed for that approver alone and good for 7 days. Teams cards use the same page.'
    },
    {
      type: 'ul',
      items: [
        'The button opens a page that says where the approval stands now and keeps saying it while open: “Already approved by Beth Lee at 10:42 AM”, “Waiting on Finance review”, “This approval was withdrawn”.',
        'Deciding still needs the approver named in the link, signed in to Nivaro in that browser, and a press of the button on the page (a link scanner that opens the email decides nothing). A link decides once.',
        'A second press, a second tab, or a colleague who decided first never shows an error: the page shows the decision that stands and nothing to press.',
        'Who decided and when show only once you are signed in as someone who can read the record. Anyone else holding the link sees only “This approval has already been decided” or the step it waits on. The page never shows values from the record; “Open in Nivaro” opens it as you.'
      ]
    },
    { type: 'h2', id: 'submission-status-page', text: 'Status page for public form submissions' },
    {
      type: 'p',
      text: 'On a public form, turn on “Status page” (form editor, right column). After sending, the person gets a “Follow your request” link — and an email with it, when you pick which form field holds their email address. The page shows Received → In review → Decided and updates while it is open.'
    },
    {
      type: 'ul',
      items: [
        'Pick where the status comes from: the record’s pipeline step, or one field. Then list the steps (or values) people may see, with the stage and the words they read (for example “Approved”). Anything you did not list reads “In review” — internal step names never show.',
        'Nothing else from the record is on the page: no values, no names, no ids.',
        'Each link belongs to one submission. It is signed, works for the days you set (90 by default) and stops working when you turn the status page off. Only a fingerprint of it is stored, and it never appears in the request log.',
        'Page loads and live connections are limited per address.'
      ]
    },
    { type: 'h2', id: 'threshold-banners', text: 'Threshold banners' },
    {
      type: 'p',
      text: 'An alert definition can also show as a banner: open it under Alerts and turn on “Show as a banner”. People who open the record then see, for example, “Project US201979 just crossed 90%” with the value now, for up to 7 days while the value still holds.'
    },
    {
      type: 'ul',
      items: [
        'The banner appears without a reload when the alert fires, and goes when the value drops back.',
        'Each person can hide a banner for themselves (×). A later crossing shows again.',
        'Everyone sees banners only for records and fields they can read.',
        'Pages that list a collection’s newest crossings (a budget console, for example) show the first three and “N more”.'
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
