import type { DocSection } from '../types.js'

/** Hub operations: cross-app issues, the secret rotation helper and storage health. */

export const hubIssuesDocs: DocSection = {
  id: 'hub-issues',
  label: 'Hub: issues across apps',
  content: [
    { type: 'h1', id: 'hub-issues', text: 'Issues across apps' },
    {
      type: 'p',
      text: 'The Issues tab of the Apps hub (`/hub/issues`) shows the issue-log and crash groups of every app the Hub looks after, in one list. The same bug in three apps is one line that says "3 apps", so a fault in a shared release is seen once instead of three times. Each line links into that app’s own issue log.'
    },
    { type: 'h2', id: 'hub-issues-how', text: 'How it is read' },
    {
      type: 'ul',
      items: [
        'Every 15 minutes (cron `hub-ops-collect`, Hub only; one run at a time across processes) the Hub asks each environment for its groups of the last 30 days: a dedicated app through `GET /api/hub-link/ops/issues` (bearer = its hub token), an app on a shared deployment through `GET /api/hub-deployment/ops/apps/<app>/issues` (the deployment link). Administrators can also press Read the apps now.',
        'Only server errors and front-end crashes are sent — issues people file by hand are left out, their titles are free text.',
        'Per group (one per signature per app; rows of one crash family across releases fold): a signature, the message as a template, severity, status, hits, how many different people hit it (a count, never who), the release, the screen pattern of a crash, first and last seen, and the issue id in that app. Never a stack, a request, a record value or a person.',
        'The template is the message with its literals replaced, on the app and again on the Hub: secrets, emails, GUIDs and long opaque strings; quoted values that are not lower-case code words (`dbo.users` stays, `Jane` goes); a parenthesised list that is not code, such as SQL Server’s "duplicate key value is (Smith, Jane)"; a value with a digit after `=` or `:`; digit runs of 4 or more; two or more Capitalised words in a row (a name).',
        'An app that cannot be read keeps its last reading; the tab names it and why (no hub link, refused token, an app older than 0.3.215, not answering).'
      ]
    },
    { type: 'h2', id: 'hub-issues-signature', text: 'The signature' },
    {
      type: 'p',
      text: 'A server error is grouped by its issue fingerprint (route + message), so the same failing route and message in two apps share one signature. A crash is grouped by its family — error name, message with minified names blanked, top bundle file and screen — so it folds across releases too.'
    },
    {
      type: 'table',
      head: ['Filter', 'What it does'],
      rows: [
        ['App', 'Groups seen in that app (with their other apps still counted).'],
        ['Kind', 'Crashes (front end) or server errors.'],
        ['Severity', 'The highest severity any app gave it.'],
        ['Status', 'Open somewhere (default), resolved everywhere, or any.'],
        ['In 2 or more apps', 'Only signatures seen in several apps.']
      ]
    },
    {
      type: 'note',
      text: 'Hub administrators see every app; an app owner sees the apps they own.'
    }
  ]
}

export const hubSecretsDocs: DocSection = {
  id: 'hub-secrets',
  label: 'Hub: secret rotation',
  content: [
    { type: 'h1', id: 'hub-secrets', text: 'Secret rotation' },
    {
      type: 'p',
      text: 'The Secrets tab of the Apps hub (`/hub/secrets`, administrators) lists every secret the Hub holds or delivers, how old it is, when it is due, and how to rotate it. A value is never shown: each secret is known by a fingerprint of its stored (sealed) form, so the Hub sees that it changed without reading it. The one exception stays as before: a new deployment token or sign-in client secret is shown once, right after its rotation.'
    },
    {
      type: 'table',
      head: ['Secret', 'Rotated', 'Default schedule'],
      rows: [
        [
          'Hub token (per environment)',
          'Docker environments: here — a new token, delivered by Apply now (typed environment key to confirm). Others: set HUB_TOKEN on the app, then type it on the environment.',
          '180 days'
        ],
        [
          'Shared deployment token',
          'On the shared deployment’s page (it shows the settings block and the 24 h grace with the new token)',
          '180 days'
        ],
        [
          'Sign-in client secret',
          'Here, through Sign-in’s rotate (shown once; set HUB_CLIENT_SECRET)',
          '365 days'
        ],
        ['Sign-in signing key', 'Here, through Sign-in’s rotate', '180 days'],
        ['Driver token, target token', 'Where it lives (a new GitLab or agent token)', '365 days'],
        [
          'Stack secrets, shared deployment secrets, database logins, app sign-in secrets',
          'Where they live',
          'None'
        ],
        ['App encryption key', 'Never (it would mean re-encrypting the app’s data)', 'Never']
      ]
    },
    { type: 'h2', id: 'hub-secrets-hub-token', text: 'Rotating a hub token here' },
    {
      type: 'ul',
      items: [
        'Refused while a move is open, while a promotion or Apply now holds the environment, or while a deploy of it is planned or running.',
        'The new token is written under the environment’s promotion lock, only if the token is still the one read (else ROTATE_RACED), and recorded as your rotation.',
        'The old token stays valid for 24 hours: the Hub falls back to it when the app refuses the new one, and accepts it from the app, until the app runs the new token. The check after the rotation proves the new token and ends the grace early.',
        'If Apply now cannot start, the old token is put back — unless a deploy of the environment started meanwhile (it may carry the new one) or the token changed again; then the new one is kept and the grace covers the gap. Both outcomes are logged.'
      ]
    },
    { type: 'h2', id: 'hub-secrets-schedules', text: 'Schedules and reminders' },
    {
      type: 'p',
      text: 'Each kind has a schedule — rotate every N days, remind N days before — set under Rotation schedules. The due date counts from the last rotation the Hub saw, or from when it first saw the secret. Every 15 minutes (cron `hub-secrets`) the Hub fingerprints everything again: a changed fingerprint is a rotation, wherever it was made (recorded once, however many scans see it). A value stored unsealed is shown as such, without a fingerprint. Administrators get one notice listing what is due soon or overdue, once per due date.'
    },
    { type: 'h2', id: 'hub-secrets-checks', text: 'The check after a rotation' },
    {
      type: 'p',
      text: 'About 5 minutes after a rotation the Hub checks that the NEW secret works, never the old one’s grace: the app answers the Hub over its link with the current token only (hub token, client secret, stack secrets — a hub token waits for its Apply now, up to an hour), the shared deployment answers the current token only (its previous token is not tried), the Docker agent accepts its token. A failed check tells the administrators. Check now runs it at once.'
    }
  ]
}

export const hubStorageDocs: DocSection = {
  id: 'hub-storage',
  label: 'Hub: storage health',
  content: [
    { type: 'h1', id: 'hub-storage', text: 'Storage health' },
    {
      type: 'p',
      text: 'The Storage tab of the Apps hub (`/hub/storage`) shows how full each Docker driver’s volume storage is (administrators) and what each app environment keeps in its file storage. A Docker driver’s page shows its storage card too.'
    },
    { type: 'h2', id: 'hub-storage-agent', text: 'On the Hub agent' },
    {
      type: 'p',
      text: 'Mount the storage the stacks’ volumes live on into the agent, read-only. One setting per kind: with NFS volumes, `HUB_AGENT_VOLUME_EXPORT_MOUNT` (where the agent sees the export root; `HUB_AGENT_STORAGE_PATH` is refused there); with local volumes, `HUB_AGENT_STORAGE_PATH` (where it sees `/var/lib/docker/volumes`). A bad value stops the agent at start (`STORAGE_PATH_BAD`). The agent then reports in `GET /v1/health` `storage`: total, free and used bytes (statfs), and the bytes and file count under the path (walked in the background every 15 minutes, at most 2 million entries or 2 minutes; past that the figures are a floor). The walk is off by default on NFS and on for local volumes; `HUB_AGENT_STORAGE_WALK=on|off` decides. The health call never waits on the storage: it answers the last reading and refreshes it behind; a hung NFS mount reads as `timeout` with the last good figures. The agent only reads: no volume, file or folder is created or changed.'
    },
    { type: 'h2', id: 'hub-storage-warnings', text: 'Warnings' },
    {
      type: 'ul',
      items: [
        'At 80 % used the driver is Filling up, at 90 % Almost full.',
        'When a driver’s level rises, the Hub administrators get one notice for that level naming the driver; the owners of every app on that driver (dedicated stacks and apps on a shared deployment that runs on it) get one that does not name it. Back under 80 % arms the next one.',
        'Without the mount setting, or on an older agent, the card says so instead of guessing.'
      ]
    },
    { type: 'h2', id: 'hub-storage-files', text: 'Files per environment' },
    {
      type: 'p',
      text: 'Each environment’s stored files — count and bytes, per storage kind — are read every 15 minutes over its link (`GET /api/hub-link/ops/files`, or the deployment link for an app on a shared deployment), with the growth since the last reading. Counts only, never a file name.'
    }
  ]
}
