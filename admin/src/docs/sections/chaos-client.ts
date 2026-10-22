import type { DocSection } from '../types.js'

export const chaosClientDocs: DocSection = {
  id: 'chaos-client',
  label: 'Browser Chaos & Pretend Down',
  audience: 'admin',
  content: [
    { type: 'h1', id: 'chaos-client', text: 'Browser Chaos & Pretend Down' },
    {
      type: 'p',
      text: 'Browser chaos mode makes **your own tab’s** requests fail or slow down for a few minutes, so you can watch how screens cope: error messages, retry buttons, autosave and the offline outbox. Nothing is injected on the server and nobody else is affected.'
    },
    {
      type: 'note',
      text: 'Available to administrators when the server allows chaos drills (`GET /api/chaos/status`). It is refused in cloud mode and, on a production server, unless `CHAOS_ENABLED=true`. When the server has no chaos route the controls do not appear at all.'
    },
    { type: 'h2', id: 'chaos-client-toolbar', text: 'The chaos toolbar' },
    {
      type: 'p',
      text: 'Open it from your user menu → **Browser chaos**, or press **⌘ Shift .** (Ctrl Shift . on Windows) anywhere. Pick what breaks, how hard and for how long, then Start. While it runs, a pill in the bottom-right corner shows what is on and the time left; its × stops it at once.'
    },
    {
      type: 'table',
      head: ['Preset', 'What your tab sees'],
      rows: [
        [
          'Flaky network',
          'A share of requests (5–90%) fail as if the network dropped them; the rest arrive late.'
        ],
        [
          'API down',
          'Every API call answers 503, as a proxy does when no API server is behind it.'
        ],
        ['Slow API', 'Every API call waits longer (0.25–10 s).'],
        [
          'Offline',
          'Requests fail as if the network is gone, and the browser reports itself offline, so the offline banner and outbox take over.'
        ],
        [
          'Socket gone',
          'Live updates stop; at the end the tab reconnects and reloads what it missed.'
        ],
        [
          'Fail my next saves',
          'The next N creates, edits or deletes answer 500. Reads keep working. Combines with any preset or runs on its own.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'It always ends on time (1 to 30 minutes). A reload of the tab keeps it on until then; closing the tab ends it.',
        'Signing in and out, the chaos controls themselves and the error reporter are never broken.',
        'Crash reports sent while chaos is on are marked and not filed as issues.',
        'With several tabs open, live updates come over one shared connection: Socket gone silences only this tab, the others keep theirs.'
      ]
    },
    { type: 'h2', id: 'chaos-client-pretend', text: 'Pretend down in design mode' },
    {
      type: 'p',
      text: 'While designing a dashboard or a form, you can see how it looks when something it depends on fails. On a dashboard use **Pretend down** in the header; in the layout editor (and a record page’s Edit layout) open **Preview** and use the Pretend down list at the bottom.'
    },
    {
      type: 'ul',
      items: [
        'The list names what the view uses: the data behind each group of dashboard widgets, a form’s record widgets and panels (pipeline, owners, comments, tasks…), the AI gateway, partners and external APIs, and live updates.',
        'Switch one on and the widgets that use it fail through their normal error handling, so you see exactly what a person would see.',
        'Only your tab, only while the editor is open. Leaving the page turns everything back on.',
        'The Preview button says how many things are pretended down, so it is never on unnoticed.'
      ]
    },
    { type: 'h2', id: 'chaos-client-hosts', text: 'In a custom front end' },
    {
      type: 'p',
      text: 'Headless front ends built on `@nivaro/react` get the same tools. Call `installClientChaosFetch()` first thing at boot (before anything creates an SDK client), mount `<ClientChaosToolbar user={me} />` once, and add `clientChaosAxiosInterceptor(AxiosError)` to any axios instance. Sockets created through `createWorkerSocket` or `createSocketRealtime` are covered automatically; call `bindClientChaosSocket(socket)` for any other.'
    },
    {
      type: 'pre',
      code: `import { installClientChaosFetch, ClientChaosToolbar } from '@nivaro/react'

installClientChaosFetch() // before anything creates a client

<ClientChaosToolbar user={{ is_admin: me.is_admin }} />`
    }
  ]
}
