import type { DocSection } from '../types.js'

export const activityTrailDocs: DocSection = {
  id: 'activity-trail',
  label: 'Tamper-evident activity trail',
  audience: 'admin',
  content: [
    { type: 'h1', id: 'activity-trail', text: 'Tamper-evident activity trail' },
    {
      type: 'p',
      text: 'Every activity log entry is sealed into a hash chain: its `seal_hash` is `sha256(previous seal_hash + canonical(entry))`. Changing, inserting or deleting an entry afterwards breaks the chain at that point, and the daily check says where.'
    },
    {
      type: 'ul',
      items: [
        'Sealing never slows a write: the `activity-seal` job (every minute, one process) seals new entries, and existing entries in capped batches until the backlog is through.',
        'The canonical form is a fixed, versioned column list (id, timestamp, action, user, ip, user agent, collection, item, comment, origin, legacy id, chain, API key, auth method, MCP connection, app). Columns added later are not covered by version 1, so old seals never change.',
        'The `activity-trail-verify` job (02:40 UTC daily, heavy slot) recomputes the chain from the last good checkpoint and stores a checkpoint: intact or the first entry that does not match. Check now and Full check run it on demand.',
        'Retention purges stay verifiable: the entry after a purged one keeps the purged entry’s hash (a bridge), and checks restart from their checkpoint. A deletion that did not go through the purge shows as a gap.',
        'A break stays reported until an administrator acknowledges it with a note (audited); checks then continue from that point.',
        'Readiness check `activity-trail` fails on an open break and warns while sealing lags or no check has run.'
      ]
    },
    {
      type: 'pre',
      code: `GET  /api/activity-trail/status                    # intact through / first broken entry / backlog
GET  /api/activity-trail/checkpoints               # newest checks
POST /api/activity-trail/verify {full?}            # 202, runs in the background
POST /api/activity-trail/checkpoints/:id/acknowledge {note}
GET  /api/activity/evidence?from=YYYY-MM-DD&to=YYYY-MM-DD   # zip (≤ 100,000 entries)`
    },
    { type: 'h2', id: 'activity-evidence', text: 'Evidence export' },
    {
      type: 'p',
      text: 'The evidence bundle is a zip an auditor can check without Nivaro: `entries.csv` (every entry in the window with seal position, previous hash, seal hash and the exact canonical text), `manifest.json` (the algorithm, the canonical columns, the checkpoint the check started from, the chain heads recorded, a verification computed at export time and the sha256 of every file) and `summary.html`. The response header `x-evidence-manifest-sha256` and the activity entry logged for the export both carry the manifest hash.'
    },
    { type: 'h2', id: 'log-retention', text: 'Log retention' },
    {
      type: 'p',
      text: 'Security & privacy → Log retention lists every log Nivaro keeps — activity, revisions, trash, API requests, browser timings, search, mail, external calls, outbound recorder, job runs, AI calls and conversations, chat history, session recordings, partner payloads, event journal, notifications, webhook deliveries, alert log, slow traces — with how long each is kept, where that is set, its size, its oldest entry and when it is next purged (`GET /api/log-retention`).'
    },
    {
      type: 'note',
      text: 'A legal hold on a record keeps its activity, revisions, trash copy and linked expired files through every purge. Purges marked “Holds” on the page honour them.'
    }
  ]
}
