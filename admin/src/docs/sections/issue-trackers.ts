import type { DocSection } from '../types.js'

export const issueTrackers: DocSection = {
  id: 'issue-trackers',
  label: 'GitLab Issue Sync',
  content: [
    { type: 'h1', id: 'issue-trackers', text: 'GitLab Issue Sync' },
    {
      type: 'p',
      text: 'GitLab issue sync sends problems Nivaro already knows about to the developers in GitLab and keeps the two in step both ways. It lives on the Issue trackers tab of Connections (`/connections/trackers`, admins only). Three kinds of Nivaro item can be linked to a GitLab issue: issue-log entries (errors, crashes, monitor failures, bug reports), support tickets and any business record. Nothing is lost when GitLab is down: every call to GitLab is queued and retried.'
    },
    {
      type: 'note',
      text: 'GitLab sync is OFF by default and self-hosted only (never available in cloud mode). The issue log, support desk and records work exactly as before while it is off or no connection exists.'
    },
    { type: 'h2', id: 'issue-trackers-switch', text: 'Turning it on' },
    {
      type: 'p',
      text: 'The Issue trackers tab opens with one switch. Order of precedence: cloud mode (always off), the environment variable `ISSUE_TRACKERS=on|off`, the stored setting (key `issue_trackers` on this instance’s settings overrides row, so it is never promoted between environments), then off. With the env variable set the switch is read-only and says why. While off, every `/api/trackers*` route except the switch answers 404 `FEATURE_OFF`, the webhook answers 404, and every GitLab control disappears from the issue log, tickets and records. Queued GitLab writes wait and nothing is deleted; turning it on again resumes the queue and catches up. Each change is written to the activity log.'
    },
    { type: 'h2', id: 'issue-trackers-connection', text: 'Connection and webhook' },
    {
      type: 'ul',
      items: [
        'A connection holds the GitLab base URL, a personal or project access token (stored like External API secrets, masked on every read, never logged) and a default project. Test connection shows the GitLab user, the default project with the token’s access level and when the last webhook arrived; a failure explains why (wrong token, unreachable host). A GitLab on a private address needs `SSRF_ALLOW_HOSTS` on the server; the test says so.',
        'Webhook setup: the tab shows the URL to paste into GitLab (built from the admin host) and a secret shown once at creation or rotation (Rotate secret). Tick Issues events and Comments events. "Check it arrived" compares against the last webhook time read from the server.',
        'The webhook is `POST /api/tracker-hooks/gitlab/:connectionId`. It has no session: the `X-Gitlab-Token` header is compared to the stored secret hash in constant time before the body is read, and an unknown connection and a wrong token get the same 401. The body is limited to 1 MB, deliveries are de-duplicated on `X-Gitlab-Event-UUID`, it answers 200 at once and applies the change in the background; a paused connection answers 200 and ignores the delivery. Failed token checks are counted per address (20 in 10 minutes, then 429 for further failures); a delivery whose token checks out is never limited, and the route stays out of the shared anonymous rate limit. It is not exempt from the maintenance freeze (GitLab retries the 503). GitLab disables a webhook after repeated 4xx answers (while the feature was off, say): after turning GitLab sync back on, re-enable the hook in GitLab (Settings → Webhooks).',
        'If the webhook is missing or silent, a reconcile job (every 10 minutes) reads recent GitLab changes for linked issues, so sync still works, only slower. The health strip shows last webhook, last reconcile, queued and dead sends.'
      ]
    },
    { type: 'h2', id: 'issue-trackers-sources', text: 'What can be linked' },
    {
      type: 'table',
      head: ['Source', 'Who creates or links', 'What syncs'],
      rows: [
        [
          'Issue-log entry (`issue`)',
          'Admins, from the detail panel, row menu or bulk bar (bulk is limited to 50 per action); rules can open them automatically.',
          'Status (GitLab closed becomes resolved or closed per the connection mapping; reopened becomes open), priority and lane labels, comments both ways, "seen again" notes, recurrences.'
        ],
        [
          'Support ticket (`ticket`)',
          'Admins and people who work the ticket; plus roles listed in the connection’s `create_roles` for tickets they can update.',
          'Status (closed becomes done, reopened becomes open), ticket priority and lane labels, comments both ways. A GitLab reply, close or reopen notifies like a desk reply or status change.'
        ],
        [
          'Any record (`record`, as `collection:id`)',
          'Admins, plus `create_roles` for records they can update. Record ⋯ menu: Create GitLab issue / Link GitLab issue.',
          'Comments both ways on the record’s own thread (never field comments). No status sync: a GitLab close or reopen is written as a record comment. Fields in the GitLab text are only those the creating person can read.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Per connection, `sources` switches each kind on or off (default all on). A switched-off source gets no rules, no buttons and no sync; existing links keep their chip. People other than admins creating through `create_roles` use only the connection’s default project and may set only the title, description and extra labels; they can link only existing issues in that default project, never a confidential one. Their GitLab chip never carries GitLab’s own title.'
    },
    { type: 'h2', id: 'issue-trackers-sync', text: 'How the two sides stay in step' },
    {
      type: 'ul',
      items: [
        'Comments: every Nivaro comment on a linked item is posted to GitLab under the connection token, prefixed with the author’s name; @mentions become plain names so GitLab never pings by accident. Every GitLab comment shows to everyone who can read the item, with a GitLab badge. Each side marks mirrored comments (hidden markers such as `<!-- nivaro:comment:<id> -->`) so nothing echoes back. Internal or confidential GitLab notes are skipped. Linked issues show the notice "Comments here are shared with GitLab".',
        'Labels on create: connection `always` labels, `by_severity`, `by_source`, the rule’s templated labels and any labels picked by hand, de-duplicated. `on_example` labels are added when an example joins. The pickers list the project’s real labels; a new typed label is created by GitLab.',
        'Priority and lanes: `priority_map` (one label per severity), `lane_map` (one label per status) and a separate `ticket_priority_map` / `ticket_lane_map`. A change swaps labels in one call so lanes never stack. With two-way on, a mapped label added in GitLab sets the priority or status on every member. A state change and a lane change in one event: the state wins. Nivaro’s own just-sent change is not applied back.',
        'Seen again: new occurrences of a linked issue add a throttled note (count, people, last route, build), at most one per hour (the server clamps the interval to 60 minutes or more).',
        'Recurrence: the issue log still opens a fresh row when a resolved problem comes back. The new row joins the existing link by fingerprint; if the GitLab issue is closed, `recur_when_closed` decides: reopen it (default, when `reopen_on_recur` is on) or open a new one that mentions the old.',
        'One GitLab ticket is one bug: it can hold several Nivaro items (recurrences, grouped variants, similar items). GitLab closes only when every member is resolved or closed; a person reopening any member reopens GitLab, and then the siblings reopen from GitLab. A change made by the GitLab machine user is never sent back.',
        'GitLab issues a person wrote and Nivaro linked (`created_via` linked) or brought in (`imported`) get comments and example notes only. Closing, reopening and lane or priority label swaps are pushed to them only when the connection’s `push_to_linked` is on (default off), so a human’s ticket never changes by surprise.'
      ]
    },
    { type: 'h2', id: 'issue-trackers-import', text: 'Issues opened in GitLab' },
    {
      type: 'p',
      text: 'By default only issues Nivaro sent or linked are synced. With "Bring new GitLab issues into Nivaro" on (`import_new_issues`, per connection, default off), an issue a person opens directly in GitLab becomes an issue-log entry (source GitLab), linked like any other, so close and reopen, labels, priority and lanes, and comments sync from then on. Optional `import_label`: only issues carrying that label come in.'
    },
    {
      type: 'ul',
      items: [
        'Which projects: the connection’s default project and every project one of its enabled rules creates issues in. Webhooks from any other project are ignored.',
        'Only open, non-confidential issues opened after the switch was turned on (`import_since`, set by the server when you save; the client cannot back-date it). An older open issue comes in when someone adds the import label to it. The reconcile pass picks up issues whose webhook was missed, never older ones.',
        'The new entry: title, the description as plain text (relative GitLab links made absolute, up to 8,000 characters) under "Opened in GitLab by …" and the issue URL, priority from the priority map when two-way priority is on (else Medium), In progress when the lane map says so and two-way lanes is on, raised by the GitLab sync machine user. It is never sent back to GitLab as a new issue, and like a linked issue a person wrote it only gets closes, reopens and label swaps from Nivaro when `push_to_linked` is on.',
        'Never twice and never an echo: an issue whose description carries a Nivaro marker, that matches a create Nivaro has queued or is sending (same project and title), or that the connection’s own token opened is never brought in, whichever arrives first. The link row is inserted first as the claim, so a redelivered webhook or a webhook racing the reconcile pass brings an issue in once.',
        'Flows hear about it through `gitlab.issue_changed` with change `imported`.'
      ]
    },
    { type: 'h2', id: 'issue-trackers-similar', text: 'Similar items join instead of duplicating' },
    {
      type: 'p',
      text: 'Before any create, Nivaro looks for a home: a link with the same fingerprint, then a link holding a stored member of the issue’s group, then similarity (embeddings of the title and the first 500 characters of the text against open linked issues from the last 90 days and a title search in the project). Settings `similar.enabled` (default on), `join_at` (default 0.88) and `suggest_at` (default 0.78). A rule at or above `join_at` joins instead of creating (decision `joined_similar`); a manual create shows candidates at or above `suggest_at` first ("Add as example" or "Create new anyway"). Each new member posts one "Another example" note. A flood of examples is bounded: at most 5 example notes per link per hour, then one rolled-up note per hour, and one reopen per link per hour. The detail panel lists the link’s members with Remove and Move to a new GitLab issue.'
    },
    { type: 'h2', id: 'issue-trackers-rules', text: 'Rules' },
    {
      type: 'p',
      text: 'Rules (`/connections/trackers`, Rules view) open GitLab issues on their own. They run in order; the first rule that matches, passes its threshold and guards acts, unless it is marked continue-after. A rule applies to `issue` (issue log) or `ticket` (support tickets). Records are automated through Flows (below).'
    },
    {
      type: 'table',
      head: ['Part', 'What it holds'],
      rows: [
        [
          'Match',
          'Source, severity (low, medium, high, critical), status, text (words; * is a wildcard — regular expressions are not supported), route, collection, environment, release, group, fingerprint, raised-by role or person, assigned or not, screenshot or replay present, age. Ticket rules: category, priority, status, requester role, text, age.'
        ],
        [
          'Threshold',
          'Occurrences, distinct people, open longer than, recurred after resolve, in a window from 5 minutes to 30 days (exact up to 90 days, from durable hit counters). Issue rules only.'
        ],
        [
          'Guards',
          'Defaults on: 5 per rule per hour, 20 per rule per day, 30 per connection per hour (a claim is made in SQL before the send, so replicas cannot overshoot), cooldown per group, quiet hours (held and re-evaluated, not dropped), skip when already linked, skip resolved or closed. Joining an existing issue does not use the caps; a manual create by an admin is never capped; Flow creates and creates by people in the create roles count toward the connection cap.'
        ],
        [
          'Action',
          'Connection, project, issue type (issue or incident), labels, assignees (or map by email), milestone, due, weight, confidential, title and description as Liquid templates, attachments (screenshot and replay link off by default), and assigning the Nivaro item.'
        ],
        [
          'Mode',
          '`create` opens the GitLab issue. `suggest` only marks the item "Suggested for GitLab" with a one-click Create, so a rule can be tried without opening anything.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The builder reads as plain sentences with a live preview ("would have opened N issues in the last 7 or 30 days", with the held-back ones named), a "Why didn’t it fire for issue #123?" box (explain), a sample that renders the title, body and labels against a real item, and a list of the template variables. Every evaluation that matched but did not act is stored with its reason (last 200 per rule). A 5-minute sweep re-evaluates anything missed, so a restart never loses an evaluation.'
    },
    { type: 'h2', id: 'issue-trackers-flows', text: 'Flows' },
    {
      type: 'p',
      text: 'GitLab sync adds a Flow operation `gitlab.create_issue` (connection, project, title and body templates, labels; opens a GitLab issue for the flow’s record, a ticket or an issue-log entry, reading fields as the person who set the flow off; already linked is skipped) and a Flow trigger `gitlab.issue_changed` (change is state, labels, comment or imported; one event per linked Nivaro item, ids only in the payload). Both do nothing while sync is off.'
    },
    { type: 'h2', id: 'issue-trackers-reliability', text: 'Reliability' },
    {
      type: 'ul',
      items: [
        'Every write to GitLab is an outbox row first. A worker (every 30 seconds) retries with backoff from 30 seconds up to 1 hour; after 10 attempts, or at once on a permanent refusal, the row is `dead` and shown on the health strip with Retry and Discard.',
        'Create is idempotent: the GitLab text carries a hidden marker and a retry searches for it before creating again, so a timeout never makes a duplicate.',
        'The first send that goes dead on a connection each UTC day raises one warning issue on the issue log ("GitLab sync: a change could not be sent"); later dead rows that day add no more.',
        'A 401 or 403 from GitLab (an authentication or permission refusal) marks the connection broken (banner) and holds the row for an hour without spending one of its 10 attempts, so fixing the token loses nothing; a missing project pauses the rules that use it with the reason.',
        'Background jobs (self-hosted, on the cron leader only): `tracker-sweep` every 5 minutes, `tracker-outbox` every 30 seconds, `tracker-reconcile` every 10 minutes, `tracker-prune` nightly (hit counters older than 90 days, inbound events older than 30 days, decisions beyond 200 per rule).',
        'Readiness check `tracker-health` (Integrations group) warns on dead sends, a broken connection, or linked issues with no webhook in 24 hours. It passes while sync is off or nothing is connected and skips until migration 532 has run.'
      ]
    },
    { type: 'h2', id: 'issue-trackers-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        [
          '`GET /api/trackers/feature/public`',
          'Signed in',
          'Whether GitLab sync is on, so any screen can hide its GitLab controls.'
        ],
        [
          '`GET /api/trackers/links/for?source_kind&source_id`',
          'Signed in, can read the item',
          'The GitLab chip(s) for an issue, ticket or record: link, iid, state and title only.'
        ],
        [
          '`GET /api/trackers/creatable?source_kind`',
          'Signed in',
          'Connections this person may create or link on for that kind (admins: every active one that syncs it; others: their `create_roles` ones).'
        ],
        [
          '`POST /api/trackers/links` and `POST /api/trackers/links/existing`',
          'Admins; `create_roles` for tickets and records',
          'Create a GitLab issue from, or link an existing one to, an item (`{source_kind, source_id, connection}` or `{issue, connection}`). Create answers 202 with the outbox id.'
        ],
        [
          '`GET` / `PUT /api/trackers/feature`',
          'Admins',
          'Read or set the master switch (409 when the environment or cloud mode decides it).'
        ],
        [
          '`GET` / `POST /api/trackers`, `PATCH` / `DELETE /api/trackers/:id`',
          'Admins',
          'Connections. The create answer carries the webhook URL and the secret once.'
        ],
        [
          '`POST /api/trackers/:id/test`, `POST /:id/rotate-secret`, `GET /:id/projects`, `/:id/users`, `/:id/labels`, `GET /:id/health`',
          'Admins',
          'Connection test, new webhook secret, GitLab pickers, and the health strip data (outbox pending and dead, last webhook and reconcile).'
        ],
        [
          '`POST /api/trackers/links/bulk`, `/links/similar`, `/links/join`, `/links/move-to-new`, `DELETE /links/issue/:id`, `GET` / `DELETE /links/source/:kind/:id`, `POST /links/:id/resync`',
          'Admins',
          'Bulk create (at most 50; `dry_run` reports what the caps would do), similar candidates, add as example, move to a new GitLab issue, unlink, list a source’s links, force a resync.'
        ],
        [
          '`GET /api/trackers/outbox`, `POST /outbox/:id/retry`, `POST /outbox/:id/discard`',
          'Admins',
          'The send queue and its dead rows.'
        ],
        [
          '`GET`/`POST /api/trackers/rules`, `PATCH`/`DELETE /rules/:id`, `POST /rules/reorder`, `POST /rules/preview`, `GET /rules/explain?issue=`, `POST /rules/sample`, `GET /rules/template-vars?kind=`',
          'Admins',
          'Rule CRUD and ordering, the 7 or 30 day preview, why-didn’t-it-fire, a rendered sample, and the documented template variables per kind.'
        ],
        [
          '`POST /api/tracker-hooks/gitlab/:connectionId`',
          'GitLab (secret token)',
          'The webhook described above.'
        ],
        [
          '`GET /api/issues?tracker=linked|unlinked|suggested`',
          'Admins',
          'The issue log filter. While sync is on, every issue row carries `tracker` (admins: the link; others: the chip) and admins also `tracker_suggested_rule`.'
        ]
      ]
    },
    {
      type: 'warn',
      text: 'Migration 532 creates the tracker tables (`nivaro_tracker_*`, `nivaro_issue_hits`, `nivaro_issue_hit_people`) and adds `nivaro_comments.meta` and `nivaro_issues.tracker_suggested_rule`. Connections and rules are per-environment configuration: every environment points at its own GitLab project or none, so the tables belong on the "never promote" side of any config promotion.'
    }
  ]
}
