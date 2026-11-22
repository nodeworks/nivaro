import {
  describeError,
  type ErrorDescription,
  errorToastOptions,
  isRawErrorText
} from '@nivaro/shared'
import type { DataTag } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  type ChecklistItem,
  DB_CODE_COPY,
  type DbEngine,
  type DbServerTls,
  type HubDatabaseRow,
  SSL_LABEL
} from '../databases/db-api'
import { hubError } from '../hub-api'

/**
 * Nivaro Hub (phase 3) — what the Apps hub reads and sends to create a new app: targets (where
 * new apps go), the creation plan and start, and one environment's creation progress. Types,
 * query keys, fetchers and the copy for every refusal these routes answer.
 */

// ─── Targets ──────────────────────────────────────────────────────────────────

export interface HubTargetConfig {
  api: string
  namespace: string
  template_project: string
  template_ref: string
  pin_file: string
  deploy_job: string
  deploy_host: string
  manager_known_hosts: string
  proxy_network: string
  dns_mode: 'automatic' | 'manual'
  wildcard_domain: string | null
  edge_address: string | null
  scheme: 'https' | 'http'
  port: number | null
  cert_note: string | null
}

export interface HubTarget {
  id: number
  kind: 'gitlab'
  name: string
  config: HubTargetConfig
  /** '••••••' when a token is stored (never the token itself), else null. */
  secret: string | null
}

export interface TargetCheck {
  id: 'token' | 'namespace' | 'template'
  ok: boolean
  text: string
}

/** One app's sync after a target change; `pending` = still finishing in the background. */
export interface TargetSyncResult {
  app_id: number
  ok: boolean
  code?: string
  pending?: true
}

export interface TargetSaveAnswer {
  data: HubTarget
  /** PATCH only: one entry per app made on this target; null when the sync could not start. */
  sync?: TargetSyncResult[] | null
  sync_error?: string
}

// ─── Databases ────────────────────────────────────────────────────────────────
// The servers, databases, checklist and connection form are the Databases tab's (databases/
// db-api.ts): same types, same query keys, same refusal copy. Only what the creation view adds
// lives here.

/** The TLS settings of a database's server, as the creation view carries them (no login). */
export type CreationServerTls = DbServerTls

/** The server's TLS in words, for an owner's read-only field (ruling P3-24). */
export function serverTlsWords(tls: CreationServerTls | null | undefined): string | undefined {
  // null = the database has no server (an owner cannot connect it); undefined = not sent.
  if (tls === null) return 'No server is recorded for this database'
  if (!tls) return undefined
  const mode = tls.ssl_mode ? SSL_LABEL[tls.ssl_mode] : 'Engine default'
  return tls.trust_server_cert ? `${mode}, server certificate trusted` : mode
}

// ─── Creation ─────────────────────────────────────────────────────────────────

export interface CreateAppInput {
  key: string
  name: string
  owners: string[]
  first_admin: { email: string; first_name?: string; last_name?: string }
  target_id: number
  version: string
  signin: { issuer: string; client_id: string; client_secret: string }
  environments: Array<{
    key: string
    hostname?: string | null
    database:
      | { server_id: number; database_name?: string; login_name?: string }
      | { database_id: number }
  }>
}

export interface CreationBlocker {
  code: string
  text: string
  /** The environment key the blocker is about — or "environment N" when its key is not valid. */
  env?: string
}

export interface CreationPlanEnvironment {
  key: string
  position: number
  hostname: string | null
  base_url: string | null
  dns_mode: 'automatic' | 'manual'
  ticket: string | null
  redirect_uri: string | null
  branch: string
  source_branch: string
  stack_name: string | null
  database: {
    mode: 'automatic' | 'manual' | 'existing'
    server_name: string | null
    database_name: string
    login_name: string | null
    engine: DbEngine
    checklist: ChecklistItem[] | null
  }
}

export interface CreationPlan {
  ok: boolean
  blockers: CreationBlocker[]
  lines: string[]
  /** Things to know that do not stop the creation (an existing database with a Nivaro install). */
  warnings?: string[]
  app: { key: string; name: string; project_path: string }
  environments: CreationPlanEnvironment[]
}

export type CreationStepKey =
  | 'database'
  | 'repository'
  | 'variables'
  | 'config'
  | 'deploy'
  | 'name'
  | 'link'
  | 'admin'

export const STEP_ORDER: readonly CreationStepKey[] = [
  'database',
  'repository',
  'variables',
  'config',
  'deploy',
  'name',
  'link',
  'admin'
]

export interface CreationStepState {
  key: CreationStepKey
  status: 'pending' | 'running' | 'done' | 'waiting' | 'failed'
  at: string | null
  note: string | null
  sha?: string
}

export type CreationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

export type CreationWait = 'database' | 'name' | 'operator'

export interface CreationLogLine {
  seq: number
  at: string
  level: 'info' | 'warn' | 'error' | string
  line: string
}

export interface CreationView {
  id: number
  app_id: number
  app_key: string
  environment_id: number
  env_key: string
  status: CreationStatus
  step: string | null
  waiting_for: CreationWait | null
  operator_installed_at: string | null
  steps: CreationStepState[]
  error: string | null
  version: string
  first_admin: { email: string; first_name?: string; last_name?: string } | null
  job_run_id: number | null
  started_by: string | null
  created_at: string | null
  updated_at: string | null
  finished_at: string | null
  hostname: string | null
  base_url: string | null
  redirect_uri: string | null
  log: CreationLogLine[]
  checklist: ChecklistItem[] | null
  ticket: string | null
  /** The environment's database (masked) with its server's TLS; null server_tls = no server. */
  database: HubDatabaseRow | null
  deploy_key: {
    keyid: string
    public_key: string
    authorized_keys: string
    key_conf: string
    key_conf_path: string
  } | null
}

// ─── Query keys (creation-only endpoints; database reads use dbKeys) ───────────

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export const createKeys: {
  targets: () => Tagged<readonly ['hub-create-targets'], HubTarget[]>
  creation: (envId: number) => Tagged<readonly ['hub-creation', number], CreationView>
} = {
  targets: () => tag<HubTarget[], readonly ['hub-create-targets']>(['hub-create-targets'] as const),
  creation: (envId) =>
    tag<CreationView, readonly ['hub-creation', number]>(['hub-creation', envId] as const)
}

// ─── Fetchers ─────────────────────────────────────────────────────────────────

export const fetchTargets = () =>
  api.get<{ data: HubTarget[] }>('/hub/targets').then((r) => r.data.data ?? [])

export const saveTarget = (id: number | null, body: Record<string, unknown>) =>
  (id == null
    ? api.post<TargetSaveAnswer>('/hub/targets', { kind: 'gitlab', ...body })
    : api.patch<TargetSaveAnswer>(`/hub/targets/${id}`, body)
  ).then((r) => r.data)

export const testTarget = (id: number) =>
  api
    .post<{ data: { ok: boolean; checks: TargetCheck[] } }>(`/hub/targets/${id}/test`, {})
    .then((r) => r.data.data)

export const deleteTarget = (id: number) => api.delete(`/hub/targets/${id}`)

export const previewPlan = (input: CreateAppInput) =>
  api.post<{ data: CreationPlan }>('/hub/apps/create/plan', input).then((r) => r.data.data)

export const startCreate = (input: CreateAppInput) =>
  api
    .post<{ data: { app_id: number; environments: Array<{ id: number; key: string }> } }>(
      '/hub/apps/create',
      input
    )
    .then((r) => r.data.data)

export const fetchCreation = (envId: number) =>
  api.get<{ data: CreationView }>(`/hub/environments/${envId}/creation`).then((r) => r.data.data)

export const retryCreation = (envId: number) =>
  api.post(`/hub/environments/${envId}/creation/retry`, {})

export const checkCreation = (envId: number) =>
  api
    .post<{ data: { status: string } }>(`/hub/environments/${envId}/creation/check`, {})
    .then((r) => r.data.data)

export const cancelCreation = (envId: number) =>
  api.post(`/hub/environments/${envId}/creation/cancel`, {})

export const confirmInstalled = (envId: number) =>
  api.post(`/hub/environments/${envId}/creation/installed`, {})

/** The blockers a refused start (409) carried, if any. */
export function createBlockersOf(err: unknown): CreationBlocker[] {
  const body = (err as { response?: { data?: { blockers?: unknown } } })?.response?.data
  return Array.isArray(body?.blockers) ? (body.blockers as CreationBlocker[]) : []
}

// ─── Rules mirrored from the API (names only; the API decides) ────────────────

/** Version x.y.z (plan.ts VERSION_RE). */
export const VERSION_RE = /^\d+\.\d+\.\d+$/

/** A key an app or environment may be created with (app-config.ts isCreatableKey). */
export const isCreatableKey = (v: string) =>
  /^[a-z][a-z0-9-]{1,62}$/.test(v) && !v.endsWith('-') && !v.includes('--')

/**
 * A pinned template ref: a full commit sha or a version tag whose major number has at most 9
 * digits (targets.ts validTemplateRef — the deploy job reads it the same way).
 */
export const TEMPLATE_REF_RE = /^([0-9a-f]{40}|v?\d{1,9}(\.\d+){0,3}([-.][a-z0-9]+)?)$/

/** The automatic name: production = `<app>.<wildcard>`, others `<app>--<env>.<wildcard>`. */
export function automaticHostname(
  wildcard: string | null,
  appKey: string,
  envKey: string
): string | null {
  const suffix = (wildcard ?? '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
  if (!suffix || !isCreatableKey(appKey) || !isCreatableKey(envKey)) return null
  return `${envKey === 'production' ? appKey : `${appKey}--${envKey}`}.${suffix}`
}

/** The default database / login names (plan.ts): nivaro_<app>_<env> and <app>_<env>. */
export function defaultDbNames(appKey: string, envKey: string) {
  const a = appKey.replace(/-/g, '_')
  const e = envKey.replace(/-/g, '_')
  return { database: `nivaro_${a}_${e}`, login: `${a}_${e}` }
}

/**
 * Blockers about one environment row (by the planner's `env` label: its key, or "environment N"
 * when the key is not valid). Matched by env, never by code — codes repeat across fields.
 */
export function blockersForEnv(blockers: CreationBlocker[], envKey: string, index: number) {
  const key = envKey.trim()
  const label = `environment ${index + 1}`
  return blockers.filter((b) => b.env && (b.env === label || (key !== '' && b.env === key)))
}

/** Blockers that name no environment row on screen. */
export function appBlockers(blockers: CreationBlocker[], envKeys: string[]) {
  const labels = new Set<string>()
  envKeys.forEach((k, i) => {
    labels.add(`environment ${i + 1}`)
    if (k.trim()) labels.add(k.trim())
  })
  return blockers.filter((b) => !b.env || !labels.has(b.env))
}

/** Poll every 3 s while a leg moves, every 30 s while it waits, else not at all. */
export function creationPollMs(status: CreationStatus | undefined): number | false {
  if (status === 'running' || status === 'queued') return 3_000
  if (status === 'waiting') return 30_000
  return false
}

// ─── Words ────────────────────────────────────────────────────────────────────

export const STEP_LABELS: Record<CreationStepKey, string> = {
  database: 'Database',
  repository: 'Deploy repository',
  variables: 'Settings and secrets',
  config: 'App settings and version',
  deploy: 'First deploy',
  name: 'Hostname',
  link: 'Hub link',
  admin: 'First administrator'
}

export const STEP_STATE_WORDS: Record<CreationStepState['status'], string> = {
  pending: 'not started',
  running: 'in progress',
  done: 'done',
  waiting: 'waiting',
  failed: 'failed'
}

const CREATION_STATUS_WORDS: Record<CreationStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Waiting',
  done: 'Created',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled'
}

export const creationStatusWords = (s: string) =>
  (CREATION_STATUS_WORDS as Record<string, string>)[s] ?? (s || 'Unknown')

export const WAIT_WORDS: Record<CreationWait, string> = {
  database: 'Waiting for the database',
  name: 'Waiting for the hostname',
  operator: 'Waiting for the deploy key to be installed'
}

/**
 * A runner text stored as `CODE: sentence` (run.ts: failed steps and creation errors), split.
 * Anything else has no code.
 */
export function splitCoded(raw: string): { code: string | null; text: string } {
  const m = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*):\s*([\s\S]*)$/.exec(raw.trim())
  return m ? { code: m[1], text: m[2].trim() } : { code: null, text: raw.trim() }
}

/**
 * A step note in plain words: the server's sentence without its code, first letter up — unless
 * it starts with a name (a hostname, a database or login name), which keeps its own spelling.
 */
export const noteWords = (note: string | null) => {
  if (!note) return null
  const { text } = splitCoded(note)
  if (!text) return null
  return /^[a-z]+(\s|[,:;]|$)/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/** A target save's sync result in one short line, or null when there was nothing to update. */
export function syncSummary(a: Pick<TargetSaveAnswer, 'sync' | 'sync_error'>): {
  text: string
  tone: 'ok' | 'warn'
} | null {
  if (a.sync_error || a.sync === null)
    return {
      text: 'Saved. The apps made on this target could not be updated; save again to retry.',
      tone: 'warn'
    }
  const list = a.sync ?? []
  if (!list.length) return null
  const ok = list.filter((s) => s.ok).length
  const pending = list.filter((s) => !s.ok && s.pending).length
  const failed = list.filter((s) => !s.ok && !s.pending)
  const parts: string[] = []
  if (ok) parts.push(`${ok} ${ok === 1 ? 'app' : 'apps'} updated`)
  if (pending) parts.push(`${pending} finishing in the background`)
  if (failed.length)
    parts.push(
      `${failed.length} could not be updated (${[
        ...new Set(failed.map((f) => copyFor(f.code ?? '')?.title ?? f.code ?? 'error'))
      ].join(', ')})`
    )
  return { text: `Saved. ${parts.join(', ')}.`, tone: failed.length ? 'warn' : 'ok' }
}

// ─── Refusal copy ─────────────────────────────────────────────────────────────

type Copy = {
  title: string
  hint?: string
  /** The server's own sentence says exactly what is wrong: keep it as the hint. */
  detail?: boolean
}

/**
 * Every refusal code the creation and target routes (and the services behind them) answer, in
 * plain words. The database routes' codes read with DB_CODE_COPY (databases/db-api.ts) through
 * copyFor; a code here wins where both name it. A guard test reads the API sources and
 * services/hub/db/codes.ts and fails on a code with no copy in either table.
 */
export const CREATE_COPY: Record<string, Copy> = {
  // Plan blockers (the plan's own text is shown with them)
  BAD_KEY: {
    title: 'The app key is not valid',
    hint: 'Lower-case letters, digits and single dashes, starting with a letter.'
  },
  KEY_TAKEN: { title: 'Another app already uses this key', hint: 'Pick a different key.' },
  BAD_NAME: { title: 'The name is not valid', detail: true },
  BAD_OWNER: { title: 'An owner is not a person here', hint: 'Pick the owners again.' },
  BAD_EMAIL: { title: 'The first administrator is not complete', detail: true },
  BAD_TARGET: { title: 'Pick where the app is created', detail: true },
  BAD_VERSION: { title: 'That is not a version number', hint: 'Versions look like 0.3.210.' },
  IMAGE_MISSING: {
    title: 'The image for this version is not published',
    hint: 'Publish the release first, then try again.'
  },
  IMAGE_NO_DIGEST: {
    title: 'The image for this version has no digest to pin',
    hint: 'Publish the release again so the registry records its digest.'
  },
  BAD_SIGNIN: { title: 'The sign-in settings are not complete', detail: true },
  EXTENSIONS_UNSUPPORTED: {
    title: 'New apps start without extensions',
    hint: 'Add extensions later in the deploy repository.'
  },
  NEEDS_ENCRYPTION_KEY: {
    title: 'The Hub cannot store secrets yet',
    hint: 'Set ENCRYPTION_KEY on the Hub server, restart it, then try again.'
  },
  NO_ENVIRONMENTS: { title: 'Add at least one environment' },
  TOO_MANY_ENVIRONMENTS: { title: 'Too many environments', hint: 'An app has at most six.' },
  BAD_ENV_KEY: {
    title: 'An environment key is not valid',
    hint: 'Lower-case letters, digits and single dashes, starting with a letter.'
  },
  DUPLICATE_ENV: { title: 'An environment is listed twice' },
  BAD_SERVER: { title: 'Pick a database server', detail: true },
  SERVER_UNREACHABLE: {
    title: 'The database server did not answer',
    hint: 'Check the server on the Databases tab, then try again.'
  },
  DATABASE_NAME_INVALID: { title: 'A database or login name is not valid', detail: true },
  DATABASE_RECORDED: { title: 'That database or login is already recorded', detail: true },
  DATABASE_EXISTS: {
    title: 'That database already exists on the server',
    hint: 'Pick another name, or adopt the database on the Databases tab.'
  },
  DATABASE_IN_USE: { title: 'That database is already in use', detail: true },
  DATABASE_NOT_READY: { title: 'That database is not ready yet', detail: true },
  HOSTNAME_REQUIRED: {
    title: 'Enter the hostname',
    hint: 'This target makes names by hand: enter the name you will request.'
  },
  HOSTNAME_INVALID: { title: 'The hostname is not valid', detail: true },
  HOSTNAME_OUTSIDE_WILDCARD: { title: "The hostname is outside the target's domain", detail: true },
  HOSTNAME_TAKEN: { title: 'That hostname is already in use', detail: true },
  STACK_NAME_TAKEN: { title: 'Another environment already uses that stack name', detail: true },
  PROJECT_EXISTS: {
    title: 'The deploy repository already exists in GitLab',
    hint: 'Pick a different app key, or remove the old repository in GitLab.'
  },
  GITLAB_UNREACHABLE: {
    title: 'GitLab did not answer',
    hint: "Check the target's GitLab address and token, then try again."
  },
  NO_HUB_URL: { title: 'The Hub has no address to give the apps', detail: true },

  // Creation routes
  CREATION_RUNNING: {
    title: 'A creation is running here',
    hint: 'Wait for it to finish, or cancel it first.'
  },
  CREATION_STARTING: {
    title: 'Another creation is starting',
    hint: 'Wait a few seconds, then try again.'
  },
  ENVIRONMENT_BUSY: {
    title: 'A promotion or a creation step holds this environment',
    hint: 'Try again shortly.'
  },
  NOT_RESUMABLE: { title: 'This creation cannot do that now', detail: true },
  NOT_RUNNING: { title: 'That creation is not running or waiting' },
  NOT_WAITING_FOR_OPERATOR: {
    title: 'This creation is not waiting for the deploy key',
    hint: 'Someone may have pressed Installed already. The page shows where it is now.'
  },
  NOT_FOUND: { title: 'Not found', hint: 'It may have been removed. Reload the page.' },
  LOCK_UNAVAILABLE: {
    title: 'The Hub could not take its lock',
    hint: 'Redis may be down. Try again shortly.'
  },
  STEP_FAILED: { title: 'A creation step failed', hint: 'Open Details for what happened.' },
  HUB_ERROR: {
    title: 'The Hub could not do that',
    hint: 'Try again. If it keeps happening, the server log says why.'
  },

  // Step failures (shown as a creation's error)
  PROJECT_MISSING: { title: 'The deploy repository is not recorded yet', hint: 'Retry.' },
  PLAN_MISSING: {
    title: 'This creation lost its plan',
    hint: 'Delete the app and create it again.'
  },
  DATABASE_MISSING: { title: 'The environment has no database recorded' },
  DATABASE_DROPPING: { title: 'That database is being dropped' },
  DRIVER_MISSING: { title: 'The app has no driver recorded yet', hint: 'Retry.' },
  COMMIT_MISSING: { title: 'The settings commit is missing', hint: 'Retry.' },
  REPOSITORY_BUSY: {
    title: 'Another environment is making the deploy repository',
    hint: 'Retry in a minute.'
  },
  HUB_TOKEN_MISSING: { title: 'The environment has no Hub link token' },
  OIDC_SECRET_MISSING: { title: 'The app has no sign-in client secret' },
  DEPLOY_FAILED: {
    title: 'The deploy failed',
    hint: 'Open the pipeline in GitLab for the log, fix it, then Retry.'
  },
  NAME_NOT_SERVING: {
    title: 'The hostname does not serve the new version',
    hint: 'Check the DNS name and the proxy, then Retry.'
  },
  LINK_REFUSED: {
    title: 'The app refused the Hub link',
    hint: "The app's HUB_TOKEN does not match. Retry after the deploy finishes."
  },
  LINK_UNREACHABLE: { title: "The app's Hub link did not answer", hint: 'Retry in a minute.' },
  READ_FAILED: { title: 'The Hub could not read that app', hint: 'Save the target again.' },
  BAD_APP_SETTING: { title: 'An app setting is not allowed', detail: true },
  BAD_ANSWER: { title: 'The app answered something unexpected' },
  BAD_BASE_URL: { title: "The environment's address is not valid" },
  HUB_LINK_MISSING: { title: 'The app has no Hub link token yet', hint: 'Retry after it deploys.' },
  HUB_LINK_REDIRECT: {
    title: 'The address redirects',
    hint: 'Use the final https address.'
  },
  HUB_LINK_REFUSED: {
    title: "The token does not match the app's Hub link token",
    hint: 'Check HUB_TOKEN on the app.'
  },

  // GitLab
  GITLAB_BAD_ANSWER: { title: 'GitLab answered something unexpected', hint: 'Retry.' },
  GITLAB_BAD_NAME: { title: 'GitLab refused a name', detail: true },
  GITLAB_REFUSED: {
    title: 'GitLab refused the change',
    hint: 'Check that the token is a Maintainer on the namespace.'
  },
  GITLAB_NO_TOKEN: { title: 'The target has no GitLab token', hint: 'Add one on the target.' },
  CI_CONFIG_REFUSED: {
    title: 'GitLab refused the CI settings',
    hint: 'Check the template project and its ref.'
  },
  FORK_UNFINISHED: { title: 'GitLab did not finish copying the template', hint: 'Retry.' },
  IMPORT_FAILED: { title: 'GitLab could not copy the template', hint: 'Retry.' },
  IMPORT_TIMEOUT: { title: 'GitLab took too long to copy the template', hint: 'Retry.' },
  VARIABLE_REFUSED: {
    title: 'GitLab refused a CI variable',
    hint: 'Check the token can change CI settings.'
  },
  FETCH_REDIRECT: { title: 'GitLab redirected the request', hint: 'Use the final API address.' },
  BEFORE_JOB_FAILED: { title: 'A pipeline job before the deploy failed', hint: 'Retry.' },
  DEPLOY_JOB_UNEXPECTED: { title: 'The deploy job ran something unexpected', hint: 'Retry.' },
  DEPLOY_VARIABLES_REFUSED: { title: 'GitLab refused the deploy variables' },
  JOB_MISSING: { title: 'The pipeline has no deploy job', hint: "Check the target's deploy job." },
  JOB_RETRY_REFUSED: { title: 'GitLab would not run the job again' },
  JOB_TIMEOUT: { title: 'The deploy job took too long', hint: 'Retry.' },
  MERGE_REFUSED: { title: 'GitLab refused the merge', detail: true },
  MERGE_SHA_UNKNOWN: { title: 'GitLab named no merged commit', hint: 'Retry.' },
  MR_NO_SHA: { title: 'The merge request never got a commit', hint: 'Retry.' },
  PIPELINE_NOT_CREATED: { title: 'GitLab did not start a pipeline', hint: 'Retry.' },

  // Targets
  BAD_KIND: { title: 'A target is a GitLab target' },
  BAD_CONFIG: { title: 'A target setting is not valid', detail: true },
  BAD_WILDCARD: { title: 'The wildcard domain is not valid', detail: true },
  BAD_SCHEME: {
    title: 'Plain http is only for test names',
    hint: 'Use https, or a wildcard domain that is localhost or ends in .test.'
  },
  BAD_SECRET: { title: 'The token must be text', hint: 'Type the token again.' },
  SECRET_REQUIRED: {
    title: 'Enter the token again',
    hint: 'The GitLab address or namespace changed, so the saved token is not sent there.'
  },
  TARGET_MISCONFIGURED: { title: 'The target is not set up completely', detail: true },
  IN_USE: { title: 'It is still in use', detail: true },
  PROJECT_NOT_OURS: {
    title: 'The deploy repository was not made by the Hub',
    hint: 'The Hub only updates repositories it made. Check the app in GitLab.'
  },
  SYNC_READ_FAILED: {
    title: 'Saved, but the apps on this target were not updated',
    hint: 'Save again to retry.'
  },
  HUB_NEEDS_ENCRYPTION_KEY: {
    title: 'The Hub cannot store tokens yet',
    hint: 'Set ENCRYPTION_KEY on the Hub server, restart it, then try again.'
  },
  HUB_SECRET_NOT_SEALED: { title: "A saved secret can't be read", hint: 'Enter it again.' },
  HUB_SECRET_UNREADABLE: { title: "A saved secret can't be read", hint: 'Enter it again.' },
  // Phase 6 (Task 4): an environment placed on a shared deployment is not created here.
  SHARED_PLACEMENT: {
    title: 'This environment runs on a shared deployment',
    hint: 'The shared deployment serves it; nothing is created for it here.'
  }
}

/**
 * Plain-words copy for a code, or undefined when no screen knows it. A database code a creation
 * passes on reads with the Databases tab's copy; a creation code keeps its own words.
 */
export const copyFor = (code: string): Copy | undefined =>
  /^[A-Z][A-Z0-9_]*$/.test(code) ? (CREATE_COPY[code] ?? DB_CODE_COPY[code]) : undefined

/**
 * describeError with the creation refusals in plain words. A `detail` code keeps the server's
 * own sentence (already plain, never raw) as the hint under the copy's title.
 */
export function createError(err: unknown, fallback: string): ErrorDescription {
  const d = describeError(err, fallback)
  const copy = d.code ? copyFor(d.code) : undefined
  if (!copy) return hubError(err, fallback)
  const said = d.title !== fallback && d.title !== copy.title ? d.title : undefined
  const out: ErrorDescription = { ...d, title: copy.title }
  const hint = copy.detail ? (said ?? copy.hint) : copy.hint
  if (hint) out.hint = hint
  else delete out.hint
  return out
}

export function createToast(err: unknown, fallback: string) {
  const d = createError(err, fallback)
  toast.error(d.title, errorToastOptions(d))
}

/**
 * A creation's stored error (`CODE: sentence`, or `INTERRUPTED: note (step)`) for an ErrorNotice:
 * the code's copy as the title, the server's sentence as the hint, the raw text only in
 * "Details for support".
 */
export function creationErrorDescription(
  raw: string,
  opts: { owner?: boolean } = {}
): ErrorDescription {
  const { code, text } = splitCoded(raw)
  // An owner has no Retry and no Databases tab: their next step is to ask.
  const ownerNext = 'Ask whoever runs the Hub to retry it.'
  if (code === 'INTERRUPTED') {
    const m = /^([\s\S]*?)\s*\((\w+)\)$/.exec(text)
    const note = (m ? m[1] : text) || 'The Hub stopped'
    const step = m ? (STEP_LABELS as Record<string, string>)[m[2]] : undefined
    return {
      title: 'The Hub stopped while this ran',
      hint: `${note.replace(/\.$/, '')}${step ? ` (at ${step})` : ''}. ${opts.owner ? ownerNext : 'Retry picks up at the unfinished step.'}`,
      code,
      technical: raw
    }
  }
  const copy = code ? copyFor(code) : undefined
  const said = text && !isRawErrorText(text) ? text : undefined
  const next = opts.owner ? ownerNext : copy && !copy.detail ? copy.hint : undefined
  const hint = [said, next].filter(Boolean).join(' ')
  const d: ErrorDescription = {
    ...describeError(
      code ? { response: { data: { code } } } : null,
      copy?.title ?? 'A step failed'
    ),
    title: copy?.title ?? 'A step failed',
    technical: raw
  }
  if (code) d.code = code
  if (hint) d.hint = hint
  else delete d.hint
  return d
}
