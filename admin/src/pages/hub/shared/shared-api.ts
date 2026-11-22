import type { ErrorDescription } from '@nivaro/shared'
import { errorToastOptions } from '@nivaro/shared'
import type { DataTag } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { hubError } from '../hub-api'

/**
 * Nivaro Hub phase 6 — the Shared deployments tab: one process (one Docker stack, or one run
 * elsewhere) serving many apps. Types, query keys, fetchers and the plain words for the
 * /api/hub/shared routes (Task 3). The deployment token is shown once, on the answer that made
 * or rotated it; every read after that holds only the mask '••••••'.
 */

export type SharedMode = 'registered' | 'docker'
export type SharedStatus = 'new' | 'active' | 'upgrading' | 'retired'
export type SharedWireStatus = 'active' | 'maintenance' | 'suspended' | 'provisioning'

export interface SharedDeployment {
  id: number
  key: string
  name: string
  mode: SharedMode
  driver_id: number | null
  stack: string | null
  version_pin: string | null
  extensions: string[]
  extension_pins: Record<string, string>
  host_pattern: string | null
  link_url: string
  pool_budget: number
  status: SharedStatus
  settings: Record<string, unknown>
  /** '••••••' when a token is stored, else null; never the token. */
  token: string | null
  last_seen_at: string | null
  created_at: string | null
  updated_at: string | null
}

/** A list row: the deployment plus how many environments it serves and how many replicas. */
export interface SharedListRow extends SharedDeployment {
  apps: number
  /** null = the Hub could not read its sightings (Redis); never "no replicas". */
  live_replicas: number | null
}

export interface SharedAppRow {
  env_id: number
  env_key: string
  env_status: string
  app_id: number
  app_key: string
  app_name: string
  tenant_id: string
  status: SharedWireStatus
  /** False while a move into or out of this deployment is under way. */
  placed_here: boolean
  pool_max: number | null
  base_url: string
}

/** One process of the deployment the Hub saw ask for its tenants list. */
export interface SharedSighting {
  instance: string
  version: string | null
  /** The list it holds (its If-None-Match); null = none yet. */
  etag: string | null
  at: string
}

export interface SharedNote {
  code: string
  text: string
}

export interface SharedDetail {
  row: SharedDeployment
  apps: SharedAppRow[]
  /** null = the Hub could not read them (Redis). */
  sightings: SharedSighting[] | null
  previous_token_valid_until: string | null
  /** The tenants list's ETag now (Task 17); null when the Hub could not build it. */
  list_etag?: string | null
  /** Registered mode: what to set on the deployment (the token as a placeholder). */
  env_block: string | null
  warnings: SharedNote[]
  /** Task 5 (P6-16): the deployment's write-only secrets, each the mask when set, else null. */
  secrets?: { REDIS_URL: string | null } | null
}

export type SchemaState = 'pending' | 'running' | 'ok' | 'failed'

/** What the deployment link answered (Task 3's DeploymentStatus), or why it could not. */
export type SharedLinkStatus =
  | {
      state: 'ok'
      checked_at: string
      version: string
      instance: string
      registry: {
        count: number
        loaded_at: string | null
        etag: string | null
        stale: boolean
        dropped: { id: string; why: string }[]
      }
      apps: {
        id: string
        schema: { state: SchemaState; version: string | null; error: string | null }
      }[]
      extensions: string[]
      oidc: { issuer_host: string; tenant: string | null } | null
      process: Record<string, unknown>
    }
  | { state: 'unreachable'; code: string; message: string; checked_at: string }

export interface SharedCreated {
  row: SharedDeployment
  token: string
  env_block: string | null
}

export interface SharedRotated {
  token: string
  previous_token_valid_until: string | null
  /** Docker: whether the stack was applied again so it runs with the new token. */
  reapply: 'manual' | 'started' | 'unavailable' | 'failed'
  reapply_reason: string | null
  env_block: string | null
}

/** What a create or edit sends (the API checks everything again). */
export interface SharedInput {
  key?: string
  name: string
  mode?: SharedMode
  driver_id?: number | null
  stack?: string | null
  version_pin?: string | null
  link_url: string
  host_pattern: string | null
  extensions: string[]
  extension_pins: Record<string, string>
  pool_budget: number
  /** Docker: the stack's size and Redis (other stored settings are kept as they are). */
  settings?: Record<string, unknown>
  /** Write-only (Task 5): the external Redis address. Never read back. */
  secrets?: { REDIS_URL: string | null }
}

/** Whether the deployment has an external Redis address stored (GET shows only that). */
export const redisUrlStored = (secrets: SharedDetail['secrets']): boolean => !!secrets?.REDIS_URL

/**
 * After a change the stack reads only when it is applied again (a new Redis address, a rotated
 * token): whether that happened, in plain words. `what` names the change ("the change", "the new
 * token"); `version` is what the deployment runs, the version an upgrade re-applies.
 * `tone` ok = applied again now; warn = it waits (the person may act).
 */
export function reapplyWords(
  reapply: SharedRotated['reapply'],
  reason: string | null | undefined,
  opts: { what?: string; version?: string | null } = {}
): { tone: 'ok' | 'warn'; text: string } {
  const what = opts.what ?? 'the change'
  const now = opts.version
    ? `start an upgrade to ${opts.version} (the version it runs) to apply it now`
    : 'start an upgrade to the version it runs to apply it now'
  if (reapply === 'started')
    return { tone: 'ok', text: `The Hub is applying the stack again with ${what}.` }
  if (reapply === 'failed' && reason === 'BUSY')
    return {
      tone: 'warn',
      text: `Something holds the deployment right now (an upgrade, a move or a placement), so ${what} applies with the next upgrade. When it is free, ${now}.`
    }
  if (reapply === 'failed' && reason === 'LAST_RUN_FAILED')
    return {
      tone: 'warn',
      text: `The last upgrade failed, so the Hub did not apply the stack again: ${now}, or roll back.`
    }
  if (reapply === 'failed')
    return { tone: 'warn', text: `The Hub could not apply the stack again: ${now}.` }
  if (reapply === 'unavailable')
    return { tone: 'warn', text: `${capital(what)} applies with the next upgrade, or ${now}.` }
  return { tone: 'warn', text: `Set ${what} on every process of the deployment.` }
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/** A PATCH answer: the row, and after a secret change whether the stack is applied again. */
export interface SharedSaved {
  row: SharedDeployment
  reapply?: SharedRotated['reapply']
  reapply_reason?: string | null
}

// ─── Query keys (the plan's shapes: one key = one shape) ─────────────────────────────────────

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export const sharedKeys: {
  list: () => Tagged<readonly ['hub', 'shared'], SharedListRow[]>
  detail: (id: number) => Tagged<readonly ['hub', 'shared', number], SharedDetail>
  status: (id: number) => Tagged<readonly ['hub', 'shared', number, 'status'], SharedLinkStatus>
} = {
  list: () => tag<SharedListRow[], readonly ['hub', 'shared']>(['hub', 'shared'] as const),
  detail: (id) =>
    tag<SharedDetail, readonly ['hub', 'shared', number]>(['hub', 'shared', id] as const),
  status: (id) =>
    tag<SharedLinkStatus, readonly ['hub', 'shared', number, 'status']>([
      'hub',
      'shared',
      id,
      'status'
    ] as const)
}

// ─── Reads and writes ────────────────────────────────────────────────────────────────────────

export const fetchSharedList = () =>
  api.get<{ data: SharedListRow[] }>('/hub/shared').then((r) => r.data.data ?? [])

export const fetchShared = (id: number) =>
  api.get<{ data: SharedDetail }>(`/hub/shared/${id}`).then((r) => r.data.data)

export const fetchSharedStatus = (id: number, fresh = false) =>
  api
    .get<{ data: SharedLinkStatus }>(
      `/hub/shared/${id}/status`,
      fresh ? { params: { fresh: 1 } } : undefined
    )
    .then((r) => r.data.data)

export const createShared = (body: SharedInput) =>
  api.post<{ data: SharedCreated }>('/hub/shared', body).then((r) => r.data.data)

export const updateShared = (id: number, body: Partial<SharedInput>): Promise<SharedSaved> =>
  api
    .patch<{
      data: SharedDeployment
      reapply?: SharedRotated['reapply']
      reapply_reason?: string | null
    }>(`/hub/shared/${id}`, body)
    .then((r) => ({
      row: r.data.data,
      reapply: r.data.reapply,
      reapply_reason: r.data.reapply_reason ?? null
    }))

export const rotateSharedToken = (id: number) =>
  api.post<{ data: SharedRotated }>(`/hub/shared/${id}/token`, {}).then((r) => r.data.data)

export const deleteShared = (id: number) =>
  api
    .delete<{ data: { id: number; outcome: 'deleted' | 'retired' } }>(`/hub/shared/${id}`)
    .then((r) => r.data.data)

// ─── Derived facts ───────────────────────────────────────────────────────────────────────────

/**
 * Whether a replica holds the list the Hub serves now: yes / no, or null when the Hub could not
 * tell (no list tag from an older API, or the list could not be built).
 */
export function holdsLatest(
  s: SharedSighting,
  listEtag: string | null | undefined
): boolean | null {
  if (!listEtag) return null
  return s.etag === listEtag
}

/** The extensions the deployment loaded that differ from the Hub's allow-list (either way). */
export function extensionDrift(
  allowed: string[],
  loaded: string[]
): { missing: string[]; extra: string[] } {
  const a = new Set(allowed)
  const l = new Set(loaded)
  return {
    missing: allowed.filter((x) => !l.has(x)),
    extra: loaded.filter((x) => !a.has(x))
  }
}

/** The schema state of one app on the deployment, by tenant id (null = not reported). */
export function schemaOf(status: SharedLinkStatus | undefined, tenantId: string) {
  if (status?.state !== 'ok') return null
  return status.apps.find((a) => a.id === tenantId)?.schema ?? null
}

// ─── Copy ────────────────────────────────────────────────────────────────────────────────────

export const MODE_WORDS: Record<SharedMode, { label: string; tip: string }> = {
  docker: { label: 'Run by the Hub', tip: 'The Hub deploys and upgrades its Docker stack' },
  registered: {
    label: 'Run elsewhere',
    tip: 'Someone runs it outside the Hub (for example their own pipeline); the Hub gives out its settings and token'
  }
}

export const STATUS_WORDS: Record<SharedStatus, string> = {
  new: 'New',
  active: 'Serving',
  upgrading: 'Upgrading',
  retired: 'Retired'
}

export const WIRE_WORDS: Record<SharedWireStatus, string> = {
  active: 'Serving',
  maintenance: 'Maintenance',
  suspended: 'Suspended',
  provisioning: 'Getting ready'
}

export const SCHEMA_WORDS: Record<SchemaState, string> = {
  pending: 'Waiting to migrate',
  running: 'Migrating',
  ok: 'Up to date',
  failed: 'Migration failed'
}

/** Tone pairs (light + dark) for small chips: fine, working, attention, problem, quiet. */
export const TONE = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  busy: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300',
  warn: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
  bad: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300',
  quiet:
    'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-muted-foreground'
} as const
export type Tone = keyof typeof TONE

export const WIRE_TONE: Record<SharedWireStatus, Tone> = {
  active: 'ok',
  maintenance: 'warn',
  suspended: 'bad',
  provisioning: 'busy'
}

export const SCHEMA_TONE: Record<SchemaState, Tone> = {
  pending: 'quiet',
  running: 'busy',
  ok: 'ok',
  failed: 'bad'
}

/** Warnings on a deployment (the detail's own, the link's, an upgrade plan's), in plain words. */
export const WARNING_COPY: Record<string, { title: string; hint?: string }> = {
  HUB_URL_UNSET: {
    title: 'HUB_URL is not set on this Hub',
    hint: "The settings below name the Hub's PUBLIC_URL. Set HUB_URL to the Hub's https address so shared deployments can always reach it."
  },
  HUB_URL_PROBLEM: {
    title: "The Hub's own address is not one a deployment can use",
    hint: 'HUB_URL on this Hub must be an https origin (plain http only to localhost outside production). Fix it on the Hub, then plan again.'
  },
  MULTI_NODE_VOLUMES: {
    title: 'The Docker host has more than one node, and this stack keeps data on volumes',
    hint: 'A replica placed on another node does not see the bundled volumes. Use external Redis and object storage, or pin the stack to one node.'
  },
  SIGHTINGS_UNAVAILABLE: {
    title: 'The Hub could not read which processes it has seen',
    hint: 'Redis did not answer. The replica list is unknown, not empty.'
  },
  EXTENSIONS_DIFFER: {
    title: 'The deployment loaded other extensions than the Hub lists',
    hint: 'Restart it with the extension list below (HUB_SHARED_EXTENSIONS), or change the list.'
  },
  REGISTRY_STALE: {
    title: "The deployment's tenants list is old",
    hint: 'It could not read a new list from the Hub lately. Check that it reaches HUB_URL.'
  },
  APPS_DROPPED: {
    title: 'The deployment left some apps out of its list',
    hint: 'It refused their entries (see each app below). Fix the app, then refresh.'
  }
}

/** Refusals of the shared deployment routes, in plain words. Wins over the Hub's general copy. */
export const SHARED_COPY: Record<string, { title: string; hint?: string }> = {
  BAD_KEY: {
    title: 'The key is not valid',
    hint: '2–63 lower-case letters, digits and hyphens, starting with a letter.'
  },
  KEY_TAKEN: {
    title: 'Another shared deployment already uses this key',
    hint: 'Pick a different key.'
  },
  BAD_NAME: { title: 'Give it a name of at most 200 characters' },
  BAD_MODE: { title: 'Pick how it runs: by the Hub, or elsewhere' },
  BAD_LINK_URL: {
    title: 'The link address is not valid',
    hint: 'An https origin with no path; plain http only to localhost or a private address outside production.'
  },
  BAD_PATTERN: {
    title: 'The host pattern is not valid',
    hint: 'A wildcard name such as *.apps.example.com (lower case).'
  },
  BAD_BUDGET: { title: 'The pool budget is a whole number from 1 to 500' },
  BAD_EXTENSIONS: {
    title: 'An extension or pin is not valid',
    hint: 'Extension ids are lower-case letters, digits and hyphens; a pin names a listed extension.'
  },
  BAD_STACK: {
    title: 'The stack name is not valid',
    hint: '2–41 lower-case letters, digits and hyphens, starting with a letter.'
  },
  BAD_VERSION: { title: 'The version is not valid', hint: 'A version or image tag (no spaces).' },
  BAD_SETTINGS: { title: 'The settings are too large' },
  DRIVER_NOT_DOCKER: {
    title: 'Pick a Docker driver',
    hint: 'A deployment the Hub runs needs a Docker driver with an agent.'
  },
  IMMUTABLE: {
    title: 'A shared deployment keeps its key and how it runs',
    hint: 'Add a new shared deployment instead.'
  },
  NOT_EDITABLE: { title: 'That cannot be changed here' },
  SHARED_RETIRED: {
    title: 'This shared deployment is retired',
    hint: 'It keeps its history but can no longer be changed.'
  },
  SHARED_IN_USE: {
    title: 'Apps are still placed on this deployment',
    hint: 'Move every environment off it first, then delete it.'
  },
  SHARED_BUSY: {
    title: 'Something else is running on this deployment',
    hint: 'An upgrade, a move or a placement holds it. Wait for it to finish, then try again.'
  },
  TOKEN_CHANGED: {
    title: 'The token was rotated at the same moment by someone else',
    hint: 'Nothing was changed by you. Reload, then rotate again if you still need to.'
  },
  LOCK_UNAVAILABLE: {
    title: 'The Hub cannot make sure only one change runs on this deployment right now',
    hint: 'It cannot reach Redis. Nothing was changed. Try again in a moment.'
  },
  NOT_FOUND: { title: 'That shared deployment does not exist any more', hint: 'Reload the list.' },
  BAD_SECRETS: {
    title: 'The Redis address is not valid',
    hint: 'Use redis:// or rediss:// with a host, for example rediss://:password@redis.internal:6380/0.'
  },
  SHARED_OPERATOR_ONLY: {
    title: 'Only the operator of the shared deployment can see this',
    hint: 'It is about the whole deployment, not one app. Ask a Hub administrator.'
  },
  LINK_UNREACHABLE: {
    title: 'The deployment did not answer',
    hint: 'Check its link address and that it is running.'
  },
  LINK_REFUSED: {
    title: "The deployment did not accept the Hub's token",
    hint: 'Its HUB_DEPLOYMENT_TOKEN differs from the one the Hub holds. Rotate the token and set it on the deployment.'
  },
  LINK_BAD_ANSWER: {
    title: 'The deployment answered something the Hub could not read',
    hint: 'It may run a version without the deployment link. Upgrade it, then check again.'
  },
  LINK_MISSING: {
    title: 'There is no deployment link at that address',
    hint: 'The address answers, but not as a Nivaro shared deployment. Check the link address.'
  }
}

/** describeError with the shared deployment refusals first, then the Hub's own words. */
export function sharedError(err: unknown, fallback: string): ErrorDescription {
  const d = hubError(err, fallback)
  const copy = d.code ? SHARED_COPY[d.code] : undefined
  if (!copy) return d
  const out: ErrorDescription = { ...d, title: copy.title }
  if (copy.hint) out.hint = copy.hint
  else delete out.hint
  return out
}

export function sharedToast(err: unknown, fallback: string) {
  const d = sharedError(err, fallback)
  toast.error(d.title, errorToastOptions(d))
}

/** A link status that could not be read, as words (by its code). */
export function linkProblem(code: string): { title: string; hint?: string } {
  return SHARED_COPY[code] ?? { title: 'The deployment did not answer as expected' }
}
