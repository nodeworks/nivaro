# Logging audit — 2026-10-29

Scope: the API (`api/src/**`) and the admin client, for four kinds of logging:

1. **Audit trail** — `nivaro_activity` rows (`logActivity()`) and revisions for state-changing routes.
2. **Errors** — server catch blocks that swallow a failure that matters.
3. **Request / ops logging** — request ids in logs and `nivaro_api_logs`, cron runs in `nivaro_job_runs`, outbound calls.
4. **Client** — admin/shared errors that never reach the issue log (`POST /api/issues/client`).

## Method

- Every `app.post|put|patch|delete(...)` handler under `api/src/routes/**` (1,225 handlers) was scanned for
  `logActivity` or an items-service write (`createOne`/`updateOne`/`deleteOne`/…) in its body. 424 had
  neither; most are read-only POSTs (preview, simulate, impact, lint, render, search), presence beats,
  personal UI state, or routes whose service writes the row (people-access, field-defaults, directory-sync,
  managed procedures, payload templates, owner-team suggestions, mcp idle review, export presets, imports
  through the items service). The rest were read by hand; the security-relevant ones are below.
- Coverage of the security core was already good: roles, users (incl. bulk, copy-access, delegation),
  API keys, OAuth consent/revoke, View-as start/stop, sessions/logout, two-factor, SSO providers, SCIM,
  user groups, user scopes (admin), tree permissions, offboarding, retention, imports, exports, external
  APIs, webhooks, workspaces, procedures, payload templates, trash, record/config promotion all write rows.
- Every empty `catch {}` and `catch { return <success> }` in server code was listed (20 empty ones: all
  JSON-parse fallbacks or documented best-effort, except the sign-in guards below).
- Outbound paths checked: external API calls (`writeApiCallLog` → api call log), webhooks
  (`nivaro_webhook_deliveries`), mail (`logMail` → mail log), AI (spend/call rows), web push (warn on
  failure), crons (`plugins/cron.ts` → `nivaro_job_runs`), SMS and the Teams webhook (see below).

## Findings

Severity: High = an attacker or a credential change leaves no trace / logs can't be joined; Medium = a
failure or config change is invisible; Low = convenience, personal state, diagnostics.

| # | Area | File:line | Gap | Severity | Fixed? |
|---|---|---|---|---|---|
| 1 | Audit | `api/src/routes/settings.ts:299` (PATCH /settings) | The activity row said `update nivaro_settings` with no record of what changed: an AI key, SMTP password, storage secret or directory credential change was indistinguishable from a colour change | High | Yes — comment `changed: <column names>` (names only, unchanged columns and re-sent masks left out; `changedSettingsComment`) + test |
| 2 | Audit | `api/src/routes/oauth.ts:546` (POST /oauth/token, refresh) | A replayed refresh token (stolen-token signal) ended the connection silently: no activity row, no log line | High | Yes — `oauth-refresh-reuse` row (user + grant id) + `req.log.warn`; `consumeRefreshChecked` now returns who/which on `reused` + tests |
| 3 | Ops | `api/src/server.ts:93` | pino `reqId` was Fastify's per-process `req-N`, while `nivaro_api_logs.request_id`, `x-nivaro-request-id` and the trace use a uuid: a server error line could not be joined to its request | High | Yes — `genReqId: randomUUID()`; the request trace adopts `req.id` (`beginTrace(path, req, req.id)`), so all four carry one id. Client-supplied ids still ignored + tests |
| 4 | Errors | `api/src/auth/login-limits.ts:89,113,155` | Sign-in limits and the TOTP replay guard fail open on a Redis error (documented policy) with nothing in the log — a Redis outage silently turned off brute-force limits and TOTP replay protection | High | Yes — rate-limited warn per guard (once a minute), error name/message only, no key/user/code + test |
| 5 | Audit | `api/src/routes/teams-bot.ts:83` (GET /teams/connect, DELETE /teams/link, install, `unlink` command) | Joining a Teams account to a Nivaro user (card actions and questions then act as that user) and parting it wrote no activity row | Medium | Yes — `teams-link` / `teams-unlink` rows on `nivaro_users` with how (`sign_in` / `entra_oid` / `command` / `self`) + tests |
| 6 | Audit | `api/src/routes/custom-actions.ts:100` (PATCH /custom-actions/:id) | Create, delete and execute were logged; changing an action's config/guard (what it does, who may press it) was not | Medium | Yes — `custom-action-update` with the changed field names |
| 7 | Errors | `api/src/services/microsoft.ts:39,47` | Teams webhook: a non-2xx answer and any exception were swallowed with no log line | Medium | Yes — warn with the status / error name (never the webhook URL, it is a credential) |
| 8 | Errors / audit | `api/src/routes/items.ts:1551` | Atomic bulk rollback: when `deleteOne` refused, the error was swallowed and the row removed by raw knex (no activity row: the record's history shows a create and nothing after) | Medium | Partly — both failures now logged (`req.log.warn/error`, collection + id + error name); the raw delete still writes no activity row |
| 9 | Ops | `api/src/services/sms.ts:150` | SMS sends leave no persistent record (only in-memory Traffic Map counters); a provider failure had no log line; the existing lines printed the full phone number | Medium | Partly — failure line (provider + masked number + error name), numbers masked to the last four digits (`maskPhone`) + test. A sent-SMS log table is not built |
| 10 | Client | `admin/src/main.tsx` | Only React render crashes (PageErrorBoundary) reached the issue log; throws in handlers, timers, socket callbacks and unawaited promises died in the console | Medium | Yes — `admin/src/lib/global-error-report.ts`: window `error` + `unhandledrejection` → `POST /issues/client` with the replay link; code errors only (`isCodeError`), once per fingerprint, ≤10 per page load, browser-extension frames ignored + test |
| 11 | Client | `packages/shared` hosts (efp-new) | Same gap as #10 for other hosts: shared installs only the stale-chunk rejection handler | Low | No — host-side change; efp-new can mount the same installer |
| 12 | Audit | `api/src/routes/automation-tests.ts:216` (PATCH /:id) | Create/delete logged, update not | Low | Yes — `automation-test-update` |
| 13 | Audit | `api/src/routes/layout-reuse.ts:217` (PATCH /templates/:tid) | Create/delete logged, rename not | Low | Yes — `update` on `nivaro_layout_templates` + test |
| 14 | Audit | `api/src/routes/presence.ts:1458` (DELETE /presence/sessions/:id) | Admin ends someone's presence session with no row (presence only, not the sign-in session) | Low | No |
| 15 | Audit | `api/src/routes/oauth.ts:398,585` (POST /oauth/register, /oauth/revoke) | Anonymous client registration and token revoke: rate-limited, only in api_logs | Low | No |
| 16 | Audit | `api/src/routes/user-scopes.ts:238` (PUT /users/me/scopes/:dimension) | A person's own default filter (never a restriction): no row | Low | No |
| 17 | Audit | `api/src/routes/traces.ts:75`, `api/src/routes/realtime.ts:269` | Admin clears the slow-trace ring / realtime counters: no row | Low | No |
| 18 | Audit | `collections.ts` PATCH /reorder, `field-groups.ts` POST /reorder, `collection-layouts.ts` PATCH /:id/ungrouped-sort, `sub-rows.ts` POST /reorder | Order-only config writes: no row | Low | No |
| 19 | Audit | `api/src/routes/help-videos.ts` (upload/path/release/clip deletes, PUT contexts/requirements) | Authoring routes without their own row (publish, restore, packages and the storage paths log in services) | Low | No |
| 20 | Audit / cloud | `api/src/routes/admin/provision.ts:103,190` | Provision/configure-storage log to the server log (slug only, never the secret); a 401 with a wrong provision secret is only in api_logs | Low | No — cloud implications, flagged for nivaro-cloud |
| 21 | Errors | `api/src/services/webhook-dispatch.ts:395` | The whole dispatch is swallowed on a DB error ("never block the mutation", commented) — a failure to fire every webhook would leave no line | Low | No — intentional, commented |
| 22 | Ops | `api/src/services/microsoft.ts` | Teams webhook sends have no persistent row (Traffic Map counters only) | Low | No |
| 23 | Ops | crons, mail, external APIs, webhooks, AI, web push | Verified: every cron tick → `nivaro_job_runs`; mail → mail log; external API calls → api call log; webhooks → deliveries; AI → spend/call rows; web push failures → warn | — | n/a |

### In excluded files (other agents own them — not edited)

| # | File:line | Gap | Severity |
|---|---|---|---|
| X1 | `api/src/services/notification-channels.ts:60` | Its own Twilio-only `sendSms` bypasses `services/sms.ts`: ignores the Settings → SMS provider (SNS/Vonage/Sinch/MessageBird) and SMS test mode, and logs the full phone number (`skipping SMS to <number>`) | Medium |
| X2 | `api/src/routes/chat.ts:1011` (POST /messages/:id/pin), `:427` (PATCH /rooms/:room), scheduled PATCH/DELETE | No activity row for pin/unpin or room settings | Low |
| X3 | `api/src/routes/notifications.ts` mutes toggle / snooze | Personal state, no row | Low |
| X4 | `api/src/routes/field-watches.ts` DELETE /self | Personal unsubscribe, no row | Low |

## Counts

| Category | Found | Fixed | Partly | Not fixed |
|---|---|---|---|---|
| Audit trail | 14 (#1, 2, 5, 6, 8, 12–20) | 6 | 1 | 7 |
| Errors | 4 (#4, 7, 8, 21) | 2 | 1 | 1 |
| Request / ops | 3 (#3, 9, 22) | 1 | 1 | 1 |
| Client | 2 (#10, 11) | 1 | — | 1 |

(#8 is counted under audit and errors.) Plus 4 in excluded files, reported only.

## Notes

- No migration. No secret value is logged: settings rows name columns, OAuth rows name the grant id,
  Teams rows name the user id, SMS lines keep four digits.
- New activity actions: `oauth-refresh-reuse`, `teams-link`, `teams-unlink`, `custom-action-update`,
  `automation-test-update` (plus `update` comments on `nivaro_settings` and `nivaro_layout_templates`).
- Request ids: pino `reqId` is now the same uuid as `nivaro_api_logs.request_id`, the
  `x-nivaro-request-id` header and the trace. Log searches that matched `reqId: "req-…"` need the uuid.
