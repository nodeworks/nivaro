import { createHash } from 'node:crypto'
import { SHARED_READINESS_BLOCKERS } from '../../hub-link/shared-readiness.js'
import { COPYABLE_OBJECT_STORAGE } from '../../hub-transfer/copyable.js'
import { MIN_SHARED_POOL_MAX } from '../drivers.js'
import { holderOf, lockHolderRefusal, sharedHolderOf, sharedLockRefusal } from '../promote-lock.js'
import { routeActions } from './route-actions.js'
import type {
  MoveBlockerCode,
  MoveKind,
  MovePlan,
  MovePlanInput,
  MoveStepKey,
  MoveWarningCode,
  PlacementSide
} from './types.js'

/**
 * Nivaro Hub phase 6 (Task 15): the move plan, pure. gather.ts reads every fact; this turns them
 * into the steps, the route changes, blockers, warnings, a checklist and the hash a start binds to.
 *
 * Steps: the plan's lists for automatic routing, with one change for a shared target:
 * `place_on_target` comes before `files_warm`. The target pulls the files through its deployment
 * link, which serves only apps on its tenant list (404 UNKNOWN_APP otherwise, Task 10), and an app
 * enters that list when it is placed there (Task 2: `placed_at`, wire status `maintenance` until
 * release). Placing first is harmless: the target holds the app in maintenance (its crons too)
 * while the source serves, and `unplace` undoes it. Manual routing (preflight B8) keeps the old
 * placement serving until the new route is confirmed: the target is prepared first (placed or
 * deployed, held in maintenance, files copied warm), the manual route is waited for and verified
 * by the public name while the source still serves, and only then maintenance → idle → the delta
 * copy → target ready → release → retire.
 *
 * Text is plain words built from codes, counts, versions, names and keys of Hub records — never a
 * token, a ticket, an encryption key (not even its fingerprint) or a database connection.
 */

export const MOVE_STEPS: Record<MoveKind, MoveStepKey[]> = {
  to_shared: [
    'check',
    'place_on_target',
    'files_warm',
    'maintenance_on',
    'wait_idle',
    'files_delta',
    'target_ready',
    'route',
    'verify',
    'release',
    'retire_source',
    'done'
  ],
  to_dedicated: [
    'check',
    'maintenance_on',
    'wait_idle',
    'deploy_target',
    'target_ready',
    'files_full',
    'route',
    'verify',
    'release',
    'retire_source',
    'done'
  ],
  between_shared: [
    'check',
    'place_on_target',
    'files_warm',
    'maintenance_on',
    'wait_idle',
    'files_delta',
    'target_ready',
    'route',
    'verify',
    'release',
    'retire_source',
    'done'
  ]
}

const MANUAL_TAIL: MoveStepKey[] = [
  'route',
  'verify',
  'maintenance_on',
  'wait_idle',
  'files_delta',
  'target_ready',
  'release',
  'retire_source',
  'done'
]

export const MANUAL_MOVE_STEPS: Record<MoveKind, MoveStepKey[]> = {
  to_shared: ['check', 'place_on_target', 'files_warm', ...MANUAL_TAIL],
  to_dedicated: ['check', 'deploy_target', 'files_warm', ...MANUAL_TAIL],
  between_shared: ['check', 'place_on_target', 'files_warm', ...MANUAL_TAIL]
}

type Blocker = { code: MoveBlockerCode; text: string }
type Warning = { code: MoveWarningCode; text: string }

const toShared = (k: MoveKind) => k === 'to_shared' || k === 'between_shared'

/** A short id for a side (the hash binds to it). */
function sideId(side: PlacementSide): string {
  if (side.kind === 'shared') return `shared:${side.shared.id}`
  return `${side.kind}:${side.placement.id}`
}

function sideName(side: PlacementSide): string {
  if (side.kind === 'shared') return `shared deployment ${side.shared.key}`
  if (side.kind === 'docker') return `Docker stack ${side.stack}`
  return `GitLab placement #${side.placement.id}`
}

/** Text from the app's own report: one line, at most 300 characters, no control characters. */
function clean(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.charCodeAt(0)
    out += c < 0x20 || c === 0x7f ? ' ' : ch
  }
  return out.replace(/ {2,}/g, ' ').trim().slice(0, 300)
}

/** Design S9: why a side gave no answer, in words; a code never reaches the text. */
const ANSWER_WORDS: Record<string, string> = {
  LINK_UNREACHABLE: 'it did not answer',
  UNREACHABLE: 'it did not answer',
  LINK_REFUSED: "it refused the Hub's token",
  LINK_MISSING: 'it has no hub link (an older version, or no HUB_TOKEN)',
  LINK_BAD_ANSWER: 'it gave an answer the Hub could not read',
  LINK_SAID_NO: 'it refused the request',
  NO_HUB_TOKEN: 'the Hub holds no hub token for it',
  HUB_SECRET_UNREADABLE: 'the Hub cannot open its hub token (sealed with another Hub key)',
  AGENT_UNREACHABLE: 'its Docker agent did not answer',
  DB_UNREACHABLE: 'its database did not answer',
  CONNECTION_UNREADABLE: 'the Hub cannot open its database connection'
}
function answerWords(code: string | null | undefined): string {
  if (!code) return 'it did not answer'
  if (ANSWER_WORDS[code]) return ANSWER_WORDS[code]
  return /^[A-Z][A-Z0-9_]*$/.test(code) ? 'it gave no usable answer' : clean(code)
}

/** P6-31: to or from a shared deployment the object key prefix changes (apps/<tenantId>/ on a
 *  shared one, the bucket root elsewhere); between two shared ones it stays (one tenant id). */
function prefixChanges(input: MovePlanInput): boolean {
  return (input.from.kind === 'shared') !== (input.to.kind === 'shared')
}

function list(items: string[], max = 10): string {
  const shown = items.slice(0, max).join(', ')
  return items.length > max ? `${shown} and ${items.length - max} more` : shown
}

function busyText(holder: string | null, openMove: boolean): string {
  const fallback = {
    code: 'BUSY',
    message: 'Another action holds this environment — wait for it to end, then plan again.'
  }
  if (holder === 'unreadable')
    return "The Hub could not read this environment's lock (Redis did not answer), so it cannot tell whether another action runs. Try again shortly."
  if (holder === null && openMove)
    return 'A move of this environment is still open (running, waiting for a route, or interrupted). Resume it or roll it back first.'
  return lockHolderRefusal(holderOf(holder), fallback).message
}

function blockersOf(input: MovePlanInput, routing: 'automatic' | 'manual'): Blocker[] {
  const out: Blocker[] = []
  const add = (code: MoveBlockerCode, text: string) => {
    if (!out.some((b) => b.code === code)) out.push({ code, text })
  }
  const { kind, from, to, source: s, target_facts: t } = input
  const intoShared = toShared(kind)

  // Ruling P6-20 (Task 16): a Docker source on the traefik edge is reached only on its public
  // name; with a manual route a person moves that name, so the Hub could not put the source in
  // maintenance or roll back. Said here so the start's SOURCE_UNREACHABLE is no surprise.
  if (from.kind === 'docker' && from.edge === 'traefik' && routing === 'manual')
    add(
      'SOURCE_UNREACHABLE',
      `${sideName(from)} answers only on its public name, which a manual route moves: the Hub could not reach it afterwards to put it in maintenance or roll back. Move it to a target on the same Docker driver (automatic routing), or give the source a published port.`
    )

  // The placement and what holds it.
  if (from.kind === 'shared' && to.kind === 'shared' && from.shared.id === to.shared.id)
    add('SAME_PLACEMENT', `This environment already runs on ${sideName(to)}.`)
  if (input.locks.env !== null || input.locks.open_move)
    add('BUSY', busyText(input.locks.env, input.locks.open_move))
  for (const l of input.locks.shared) {
    if (l.upgrading)
      add(
        'SHARED_BUSY',
        `The shared deployment ${l.key} is being upgraded or rolled back — wait for it to end.`
      )
    else if (l.holder === 'unreadable')
      add(
        'SHARED_BUSY',
        `The Hub could not read the lock of the shared deployment ${l.key} (Redis did not answer), so it cannot tell whether an upgrade or another move runs. Try again shortly.`
      )
    else if (l.holder !== null)
      add(
        'SHARED_BUSY',
        sharedLockRefusal(sharedHolderOf(l.holder)).message.replace(
          'The shared deployment',
          `The shared deployment ${l.key}`
        )
      )
  }
  if (to.kind === 'shared' && to.shared.status === 'retired')
    add(
      'SHARED_NOT_ACTIVE',
      `The shared deployment ${to.shared.key} is retired; nothing moves onto it.`
    )
  // A docker deployment stays `new` until the Hub's first deploy of it ends (Task 5). A registered
  // one is run outside the Hub and never leaves `new`: it is judged by its live answer instead.
  if (to.kind === 'shared' && to.shared.status === 'new' && to.shared.mode === 'docker')
    add(
      'SHARED_NOT_ACTIVE',
      `The Hub has not deployed the shared deployment ${to.shared.key} yet. Deploy it first.`
    )
  if (t.in_use_by)
    add(
      'TARGET_IN_USE',
      `That placement is used by ${t.in_use_by}. A move needs a placement of its own.`
    )
  if (input.driver_problem) add('DRIVER_UNSUPPORTED', input.driver_problem)
  if (input.gather_failed.length)
    add(
      'GATHER_FAILED',
      `The Hub could not read ${list(input.gather_failed)}, so this plan cannot be trusted. Plan again in a moment.`
    )

  // The hub link of the dedicated side (maintenance, retire and the readiness report need it).
  const dedicatedSide = kind === 'to_shared' || kind === 'to_dedicated'
  if (dedicatedSide && !input.env.hub_linked)
    add(
      'NOT_HUB_LINKED',
      kind === 'to_shared'
        ? 'This environment has no hub link (no hub token). The Hub needs it to put the app in maintenance, read what it would lose and retire it. Link it first.'
        : 'This environment has no hub token. The new dedicated stack needs one so the Hub can hold it in maintenance and release it. Set one first.'
    )

  // The source, read live.
  if (!s.reachable && !(kind === 'to_shared' && !input.env.hub_linked))
    add(
      'LINK_UNREACHABLE',
      from.kind === 'shared'
        ? `The Hub could not read this app on ${sideName(from)}: ${answerWords(s.error)}.`
        : s.error === 'HUB_LINK_MISSING'
          ? 'The app answers but has no shared-readiness report: it runs a version older than moves need, or has no HUB_TOKEN. Upgrade or link it first.'
          : `The Hub could not read the app over its hub link: ${answerWords(s.error)}.`
    )

  // The target, read live.
  if (!t.reachable)
    add('TARGET_UNREACHABLE', `The Hub could not reach ${sideName(to)}: ${answerWords(t.error)}.`)

  // The app's encryption key (Review Focus 5).
  if (!input.app_key.known)
    add(
      'APP_KEY_UNKNOWN',
      input.app_key.unreadable
        ? "The Hub holds an encryption key entry for this app but cannot open it (it was sealed with another Hub key, or is damaged). Enter the app's ENCRYPTION_KEY again before moving it."
        : "The Hub does not know this app's encryption key. Enter it on the environment (the app's ENCRYPTION_KEY, 64 hex characters) before moving it: an app placed on a shared deployment without its key cannot seal or open any value."
    )
  else if (s.reachable && s.key_fp !== input.app_key.fp)
    add(
      'APP_KEY_MISMATCH',
      s.key_fp === null
        ? 'The app reports no encryption key of its own, so the key the Hub holds is not the one its values were sealed with. They would not open after the move.'
        : 'The app runs with a different encryption key than the one the Hub holds. Values it sealed would not open after the move. Enter the key it really runs with.'
    )
  if (
    input.app_key.known &&
    to.kind === 'docker' &&
    t.stack_key_fp !== null &&
    t.stack_key_fp !== input.app_key.fp
  )
    add(
      'APP_KEY_MISMATCH',
      "This environment's Docker stack settings hold a different encryption key than the app's. The new stack would not open what the app sealed. Make them the same first."
    )

  // Names.
  if (input.names_taken.length)
    add('HOSTNAME_TAKEN', `Another environment already claims ${list(input.names_taken)}.`)

  // Redis: source and target hold the same hub token, so they must not share a Redis db and
  // prefix (the retire and maintenance keys would collide). Judged only when both are known.
  if (s.redis && t.redis && s.redis === t.redis)
    add(
      'REDIS_SHARED',
      `The source and ${sideName(to)} use the same Redis database and channel prefix. Give the target its own Redis (or prefix) first.`
    )

  // Object storage the move cannot copy (ruling R1).
  const readinessHas = (code: string) => s.readiness.some((r) => r.code === code)
  const envStorage = (p: string | null) => p !== null && p.toLowerCase() !== 'local'
  if (
    !readinessHas('ENV_OBJECT_STORAGE') &&
    (envStorage(s.storage_provider) || envStorage(t.storage_provider))
  )
    add(
      'ENV_OBJECT_STORAGE',
      `${envStorage(s.storage_provider) ? 'The source' : sideName(to)[0].toUpperCase() + sideName(to).slice(1)} keeps files in object storage set by environment variables (STORAGE_PROVIDER). A move copies only local files, so those would be lost.`
    )

  // P6-31: on a shared deployment every object key lives under apps/<tenantId>/; to or from one
  // the prefix changes, so saved-settings objects are copied — which the pull can do only for the
  // saved-settings drivers it knows.
  if (prefixChanges(input) && !s.files?.objects)
    // R6-M-2: unknown is never "nothing to copy": a provider the copy cannot handle may hide in it.
    add(
      'STORAGE_COUNT_UNKNOWN',
      "This move changes where stored files are kept (a shared deployment keeps each app's files in its own folder), and the app did not say which storage its files are on. Plan again once it answers."
    )
  if (prefixChanges(input)) {
    const odd = Object.entries(s.files?.objects ?? {})
      .filter(([p, n]) => n > 0 && !(COPYABLE_OBJECT_STORAGE as readonly string[]).includes(p))
      .map(([p, n]) => `${n} on ${p}`)
    if (odd.length)
      add(
        'STORAGE_LAYOUT_DIFFERS',
        `This move changes where stored files are kept (a shared deployment keeps each app's files in its own folder), and some files are on storage the move cannot copy (${list(odd)}). Move them to S3, Azure or local storage first.`
      )
  }

  if (intoShared && to.kind === 'shared') {
    const target = to.shared
    // A move never changes the version.
    const version = s.version
    if (version && t.version && version !== t.version)
      add(
        'VERSION_DIFFERS',
        `The app runs ${version} and ${target.key} runs ${t.version}. A move never changes the version: promote or upgrade one side first.`
      )
    // Extensions (Decision 15): what the app record names and what the source really loads.
    const needed = [...new Set([...input.app.extensions, ...Object.keys(s.extensions)])].sort()
    const missing = needed.filter((x) => !t.extensions.includes(x))
    if (missing.length)
      add(
        'EXTENSION_NOT_ALLOWED',
        `${target.key} does not load ${list(missing)}, which this app uses.`
      )
    // Builds are compared as image pins (ruling P6-16), never version text against a digest.
    const differ = extensionPinsDiffer(input)
    if (differ.length)
      add(
        'EXTENSION_VERSION_DIFFERS',
        `${target.key} installs another build of ${list(differ)} than this app runs now.`
      )
    // The database the tenant list will name.
    if (!input.database)
      add(
        'NO_DATABASE_RECORD',
        "This environment names no Hub database record. A shared deployment learns each app's database from the Hub: on the Databases tab, adopt the app's database if it is not listed, open it and use Attach to environment."
      )
    else if (!input.database.ready)
      add('NO_DATABASE_RECORD', "This environment's Hub database record is not ready.")
    // Sign-in (Decision 13).
    if (input.app.signin_mode === 'hub' || s.signin_hub)
      add(
        'SIGNIN_VIA_HUB',
        'This app signs in through the Hub, which a shared deployment does not offer yet. Switch it to direct sign-in first.'
      )
    if (s.oidc && t.oidc) {
      const host = s.oidc.issuer_host !== t.oidc.issuer_host
      const tenant = (s.oidc.tenant ?? null) !== (t.oidc.tenant ?? null)
      if (host || tenant)
        add(
          'ISSUER_DIFFERS',
          `The app signs in with ${s.oidc.issuer_host}${s.oidc.tenant ? ` (tenant ${s.oidc.tenant})` : ''} and ${target.key} with ${t.oidc.issuer_host}${t.oidc.tenant ? ` (tenant ${t.oidc.tenant})` : ''}. Accounts would not link.`
        )
    }
    // Connections (Decision 16, T8 carry).
    if (t.pool) {
      if (t.pool.asked < MIN_SHARED_POOL_MAX)
        add(
          'POOL_TOO_SMALL',
          `An app on a shared deployment needs at least ${MIN_SHARED_POOL_MAX} database connections; this move asks for ${t.pool.asked}.`
        )
      else if (t.pool.used + t.pool.asked > t.pool.budget)
        add(
          'POOL_BUDGET',
          `${target.key} has ${Math.max(0, t.pool.budget - t.pool.used)} of its ${t.pool.budget} database connections left; this app asks for ${t.pool.asked}.`
        )
    }
    // The same database, seen from the target (ruling R2; T9 carry on colliding identities).
    // A ready record the target was never asked about is not a pass (R2, P6-15).
    if (!t.db && t.reachable && input.database?.ready)
      add(
        'DB_UNREACHABLE_FROM_TARGET',
        `The Hub did not get ${target.key} to check this app's database, so it cannot tell that the deployment reaches it.`
      )
    if (t.db) {
      if (!t.db.reachable)
        add(
          'DB_UNREACHABLE_FROM_TARGET',
          t.db.error === 'CONNECTION_UNREADABLE'
            ? `The Hub could not open the connection saved on this app's database record, so ${target.key} was never asked to check it. Save the connection again on the record first.`
            : `${target.key} cannot reach this app's database. Open the network path (or fix the record) first.`
        )
      else if (!s.db_identity || !t.db.identity)
        add(
          'DATABASE_DIFFERS',
          `The Hub cannot confirm that ${target.key} reaches the same database the app serves now: ${!s.db_identity ? 'the source' : 'the target'} does not report which server and database it reached.`
        )
      else if (s.db_identity !== t.db.identity)
        add(
          'DATABASE_DIFFERS',
          `${target.key} reaches another database (another server or name) than the one the app serves now. Check the database record.`
        )
    }
    if (t.identity_shared_with.length)
      add(
        'DB_IDENTITY_SHARED',
        `On ${target.key}, ${list(t.identity_shared_with)} report${t.identity_shared_with.length === 1 ? 's' : ''} the same database identity as this app, so the Hub cannot prove which database each one reaches. Give the databases distinct servers or names first.`
      )
  }

  // What shared would lose (Task 9): every blocker code is a blocker, whatever level it was sent
  // with (an unreadable check is sent as its blocker).
  if (kind === 'to_shared')
    for (const r of s.readiness)
      if (SHARED_READINESS_BLOCKERS.includes(r.code))
        add(r.code, `${readinessTitle(r.code)}: ${clean(r.detail)}`)

  return out
}

const READINESS_TITLES: Record<string, string> = {
  STAGED_IMPORTS: 'Staged imports do not run on a shared deployment yet',
  ROW_SCHEDULES: 'Schedules kept in table rows do not run on a shared deployment yet',
  ISSUE_TRACKERS: 'Issue tracker sync does not run on a shared deployment yet',
  EXEC_SCRIPT_FLOWS: 'Flows that run scripts do not run on a shared deployment yet',
  SQLITE: 'A SQLite database cannot be served by a shared deployment',
  ENV_OBJECT_STORAGE: 'Files in object storage set by environment variables are not copied',
  DIRECTORY_SYNC: 'Directory sync is off on a shared deployment',
  PHONE_PUSH: 'Phone push is off on a shared deployment',
  TEAMS_BOT: 'The Teams bot is off on a shared deployment',
  MAIL_RETRY: 'Automatic mail retry is off on a shared deployment',
  HUDDLE_TURN: "Huddles use the deployment's media servers",
  ENV_SMTP: "Mail set by environment variables uses the deployment's settings",
  SESSION_REPLAYS: 'Session replays are not moved',
  HELP_VIDEO_RENDERS: 'Queued help-video renders redo on the next publish'
}

function readinessTitle(code: string): string {
  return READINESS_TITLES[code] ?? code
}

function warningsOf(input: MovePlanInput, routing: 'automatic' | 'manual'): Warning[] {
  const out: Warning[] = []
  const add = (code: MoveWarningCode, text: string) => {
    if (!out.some((w) => w.code === code)) out.push({ code, text })
  }
  const { kind, from, to, target_facts: t, source: s } = input

  add(
    'SIGN_IN_AGAIN',
    'Everyone signs in again after the move: sessions live in Redis, which differs on the other side. Phone app and MCP (connected app) sign-ins must be made again too.'
  )
  // Decision 8: only when another environment of this app is already on that deployment.
  if (toShared(kind) && to.kind === 'shared' && t.siblings.length)
    add(
      'SAME_APP_ON_DEPLOYMENT',
      `${list(t.siblings)} of this app already run${t.siblings.length === 1 ? 's' : ''} on ${to.shared.key}. Environments of one app on one deployment usually hold copied databases: their stored files and sign-ins are kept apart, but test with care.`
    )
  add(
    'SIGNED_LINKS_RESET',
    'Links the app signed before the move stop working: submission status links (valid 90 days), help-video and export links and message-action links in mail. The session secret differs on the other side. People can ask for new ones. Unsaved form drafts are dropped too (they are sealed with the same secret): ask people to save their open forms before the move.'
  )
  add(
    'REPLAYS_NOT_MOVED',
    'Session replays and generated image sizes are not moved. Images are made again when asked for; old replays stay on the source until it is removed.'
  )
  if (toShared(kind) && s.oidc_unread)
    add(
      'ISSUER_UNVERIFIED',
      `The Hub could not read which sign-in issuer ${sideName(from)} uses, so it cannot compare it with the target's. Accounts link only when both use the same Entra tenant.`
    )
  const redisUnknown = unknownSides(input, s.redis, t.redis)
  if (redisUnknown)
    add(
      'REDIS_UNVERIFIED',
      `The Hub cannot see which Redis ${redisUnknown} uses. Source and target hold the same hub token, so they must not share one Redis database and channel prefix (the retire and maintenance keys would collide). Make sure they don't.`
    )
  const storageUnknown = unknownSides(input, s.storage_provider, t.storage_provider)
  if (storageUnknown)
    add(
      'STORAGE_UNVERIFIED',
      `The Hub cannot see where ${storageUnknown} keeps files. A move copies only local files: files in object storage set by environment variables (STORAGE_PROVIDER) would be lost.`
    )
  if (t.identity_unchecked > 0 && to.kind === 'shared')
    add(
      'DB_IDENTITY_UNCHECKED',
      `${t.identity_unchecked} other app${t.identity_unchecked === 1 ? '' : 's'} on ${to.shared.key} could not be compared with this app's database (too many to check, a check failed, or time ran out). The Hub cannot rule out that one of them reports the same database.`
    )
  const unpinned = extensionPinsUnknown(input)
  if (unpinned.length && to.kind === 'shared')
    add(
      'EXTENSION_PIN_UNVERIFIED',
      `The Hub cannot compare the build of ${list(unpinned)} this app runs now with the one ${to.shared.key} installs: one side names no image pin for it.`
    )
  if (t.multi_node_unread)
    add(
      'MULTI_NODE_UNVERIFIED',
      `The Hub could not read the Docker agent of ${sideName(to)}, so it cannot tell whether its swarm has several nodes with local volumes (one copy per node): files copied in could then be missing on another node.`
    )
  if (t.multi_node !== null)
    add(
      'MULTI_NODE_VOLUMES',
      `The target swarm has ${t.multi_node} nodes and its volumes are local (one copy per node): files copied in can be missing on another node.`
    )
  if (routing === 'manual')
    add(
      'MANUAL_ROUTE',
      'The Hub cannot change this route itself. Someone must route the names to the new placement (the request is in the plan); the old placement serves until the name answers from the new one.'
    )
  if (prefixChanges(input)) {
    const objects = input.source.files?.objects
    // An unknown count blocks (STORAGE_COUNT_UNKNOWN), so it needs no warning here.
    const copyable = objects
      ? COPYABLE_OBJECT_STORAGE.reduce((n, p) => n + (objects[p] ?? 0), 0)
      : 0
    if (copyable > 0)
      add(
        'STORAGE_PREFIX_CHANGES',
        `${copyable} file(s) kept in S3 or Azure storage saved in Settings are copied to a new folder in the same bucket (a shared deployment keeps each app's files under apps/<app>/; elsewhere they sit at the bucket root). They are copied, not shared: the bucket holds both copies until the old ones are removed.`
      )
  }
  if (input.target_facts.boot_maintenance === 'unproven')
    add(
      'GITLAB_BOOT_WINDOW',
      `The Hub cannot prove that ${sideName(to)} starts in maintenance: its deploy job may not pass the Hub's boot maintenance into the app (an adopted app, or an older template). So the old placement goes into maintenance while it deploys, until the Hub has switched the new app's maintenance on: people see the maintenance page for the length of the deploy, even when the route is changed by hand later.`
    )
  if (from.kind === 'gitlab')
    add(
      'OLD_STACK_STOP',
      'The old GitLab-deployed app is retired (it answers "moved"), not stopped. Stop its stack afterwards; it is on the checklist.'
    )
  if (kind === 'to_shared')
    for (const r of s.readiness)
      if (!SHARED_READINESS_BLOCKERS.includes(r.code))
        add(r.code, `${readinessTitle(r.code)}: ${clean(r.detail)}`)
  return out
}

/** Extensions a shared target pins whose build on the source the Hub cannot see (P6-16). */
function extensionPinsUnknown(input: MovePlanInput): string[] {
  const { source: s, target_facts: t } = input
  if (!toShared(input.kind)) return []
  const pins = s.extension_pins ?? null
  const needed = [...new Set([...input.app.extensions, ...Object.keys(s.extensions)])].sort()
  // A missing pin on either side is unknown, never a pass (P6-15; I-A: a registered target may
  // list an extension it pins no build for).
  return needed.filter((x) => t.extensions.includes(x) && (!t.extension_pins[x] || !pins?.[x]))
}

/** Extensions whose image pins are known on both sides and differ (P6-16). */
function extensionPinsDiffer(input: MovePlanInput): string[] {
  const { source: s, target_facts: t } = input
  if (!toShared(input.kind)) return []
  const pins = s.extension_pins ?? null
  const needed = [...new Set([...input.app.extensions, ...Object.keys(s.extensions)])].sort()
  return needed.filter(
    (x) =>
      t.extensions.includes(x) &&
      !!t.extension_pins[x] &&
      !!pins?.[x] &&
      pins[x] !== t.extension_pins[x]
  )
}

/** Which side(s) a fact is unknown on, in words; null when both are known. */
function unknownSides(
  input: MovePlanInput,
  source: string | null,
  target: string | null
): string | null {
  const parts: string[] = []
  if (source === null) parts.push(`the source (${sideName(input.from)})`)
  if (target === null) parts.push(`the target (${sideName(input.to)})`)
  return parts.length ? parts.join(' and ') : null
}

/**
 * E2E B3: `name` on the environment's public scheme and port (every name of the environment is
 * served on the same edge entrypoint); plain https://<name> when the public address is not known.
 */
function addressOf(input: MovePlanInput, name: string): string {
  try {
    const u = new URL(String(input.env.public_origin ?? ''))
    return `${u.protocol}//${name}${u.port ? `:${u.port}` : ''}`
  } catch {
    return `https://${name}`
  }
}

function checklistOf(input: MovePlanInput, routing: 'automatic' | 'manual'): MovePlan['checklist'] {
  const out: MovePlan['checklist'] = []
  if (toShared(input.kind) && input.to.kind === 'shared')
    out.push({
      id: 'callbacks_registered',
      text: `The sign-in app of ${input.to.shared.key} lists each of these redirect addresses: ${input.names.map((n) => `${addressOf(input, n)}/api/auth/callback`).join(', ')}.`,
      required: true
    })
  if (input.from.kind === 'gitlab')
    out.push({
      id: 'old_stack_stopped',
      text: 'The old GitLab-deployed stack is stopped (after the move; not needed to start).',
      required: false
    })
  if (toShared(input.kind) && input.source.oidc_unread)
    out.push({
      id: 'issuer_same',
      text: 'The source and the target sign in with the same issuer (the same Entra tenant).',
      required: true
    })
  if (input.to.kind === 'shared' && extensionPinsUnknown(input).length)
    out.push({
      id: 'extension_builds_same',
      text: `This app runs the same build of ${list(extensionPinsUnknown(input))} as ${input.to.shared.key} installs.`,
      required: true
    })
  if (input.target_facts.boot_maintenance === 'unproven')
    out.push({
      id: 'gitlab_boot_window',
      text: 'I accept that the app is in maintenance while the new GitLab-deployed app deploys (it may start without maintenance, so the old one pauses until the Hub has switched it on), or its deploy job passes HUB_BOOT_MAINTENANCE into the app.',
      required: true
    })
  if (input.target_facts.multi_node_unread)
    out.push({
      id: 'volumes_one_node',
      text: "The target's stack keeps its files on one node, or on volumes every node shares.",
      required: true
    })
  if (input.source.redis === null || input.target_facts.redis === null)
    out.push({
      id: 'redis_separate',
      text: 'The source and the target do not share one Redis database and channel prefix.',
      required: true
    })
  if (input.source.storage_provider === null || input.target_facts.storage_provider === null)
    out.push({
      id: 'storage_local',
      text: 'Neither side keeps files in object storage set by environment variables (STORAGE_PROVIDER): every file is on local storage, so the move copies it.',
      required: true
    })
  if (input.target_facts.identity_unchecked > 0 && input.to.kind === 'shared')
    out.push({
      id: 'db_identity_checked',
      text: `No other app on ${input.to.shared.key} uses this app's database server and name (${input.target_facts.identity_unchecked} could not be compared by the Hub).`,
      required: true
    })
  if (routing === 'manual')
    out.push({
      id: 'route_ticket',
      text: 'The route request is filed with whoever runs the names (DNS / proxy / certificates).',
      required: true
    })
  return out
}

/**
 * What a confirmation binds to: the kind, both sides, the target's connections, the version, the
 * names, the route changes and the codes of every blocker and warning. A start re-plans and
 * refuses (409 PLAN_CHANGED) when this differs. Texts, counts and file sizes are not part of it.
 */
function planHash(
  input: MovePlanInput,
  version: string,
  route: MovePlan['route'],
  routing: string,
  blockers: Blocker[],
  warnings: Warning[]
): string {
  const body = {
    kind: input.kind,
    env: input.env.id,
    from: sideId(input.from),
    to: sideId(input.to),
    pool_max: input.target.kind === 'shared' ? (input.target.pool_max ?? null) : null,
    version,
    hostnames: input.names,
    routing,
    route: route.map((a) => [a.side, a.op, a.host ?? null]),
    blockers: blockers.map((b) => b.code).sort(),
    warnings: warnings.map((w) => w.code).sort(),
    // Which extensions a ticked extension_builds_same covers, and which differ (M-A).
    extensions_unverified: extensionPinsUnknown(input),
    extensions_differ: extensionPinsDiffer(input)
  }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

/** Names as the route actions and the hash read them: trimmed, lower-case, each once (M-5). */
function normalNames(names: string[]): string[] {
  return [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))]
}

export function buildMovePlan(raw: MovePlanInput): MovePlan {
  const input: MovePlanInput = { ...raw, names: normalNames(raw.names) }
  const r = routeActions(input.from, input.to, input.names)
  const steps = [...(r.routing === 'manual' ? MANUAL_MOVE_STEPS : MOVE_STEPS)[input.kind]]
  const version = input.source.version ?? input.env.version_pin ?? ''
  const blockers = blockersOf(input, r.routing)
  const warnings = warningsOf(input, r.routing)
  const files = input.source.files
  return {
    kind: input.kind,
    routing: r.routing,
    steps,
    route: r.actions,
    manual_request: r.manualRequest,
    version,
    hostnames: [...input.names],
    files: { count: files?.local ?? 0, bytes: files?.bytes ?? 0, first_pull: 'full' },
    blockers,
    warnings,
    checklist: checklistOf(input, r.routing),
    plan_hash: planHash(input, version, r.actions, r.routing, blockers, warnings)
  }
}
