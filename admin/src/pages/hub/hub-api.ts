import { describeError, type ErrorDescription, errorToastOptions } from '@nivaro/shared'
import { type DataTag, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'

/**
 * Nivaro Hub (phase 1) — what the admin's Apps hub reads from /api/hub/*: types, query keys,
 * fetchers and the copy for statuses and refusals. The Hub never reads an app's records; it
 * only knows each environment's address, its status and the deploys GitLab ran.
 */

export type HubStatusState = 'ok' | 'degraded' | 'unreachable' | 'link_refused'

export interface HubApp {
  id: number
  key: string
  name: string
  signin_mode: string
  adopted: boolean
  extensions: string[]
}

export interface HubEnvironment {
  id: number
  app_id: number
  key: string
  position: number
  status: string
  base_url: string
  hostnames: string[]
  placement_id: number | null
  version_pin: string | null
  /** '••••••' when one is stored (never the token itself), else null. */
  hub_token: string | null
}

export interface HubOwner {
  user_id: string
  name: string
}

export interface HubAppFull extends HubApp {
  environments: HubEnvironment[]
  owners: HubOwner[]
}

export interface HubEnvStatus {
  state: HubStatusState
  version: string | null
  preflight: string | null
  checked_at: string
  source: 'hub-link' | 'public'
  error?: string
}

export interface HubDeploy {
  pipeline_id: number
  ref: string
  sha: string
  status: string
  started_at: string | null
  finished_at: string | null
  web_url: string
  deploy_job: { status: string; web_url: string } | null
  version: string | null
}

export interface HubDeploys {
  data: HubDeploy[]
  reason?: string
}

export interface HubDriverConfig {
  api: string
  project: string
  branch: string
  pin_file: string
  deploy_job: string
}

export interface HubDriver {
  id: number
  kind: 'gitlab'
  name: string
  config: HubDriverConfig
  /** '••••••' when a token is stored, else null. */
  secret: string | null
}

/** The mask the API shows for a stored secret; sent back unchanged it keeps the stored one. */
export const HUB_MASK = '••••••'

/** App keys: lower-case letter first, then letters, digits and dashes (2–63). */
export const HUB_KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/

/** http(s)://host[:port] with no path (the API refuses anything else). */
export const isBaseUrl = (v: string) => /^https?:\/\/[^/\s?#]+\/?$/i.test(v.trim())

// ─── Query keys (one key = one shape; every root starts 'hub') ────────────────

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export const hubKeys: {
  apps: () => Tagged<readonly ['hub-apps'], HubApp[]>
  app: (id: number) => Tagged<readonly ['hub-app', number], HubAppFull>
  envStatus: (envId: number) => Tagged<readonly ['hub-env-status', number], HubEnvStatus>
  deploys: (envId: number) => Tagged<readonly ['hub-env-deploys', number], HubDeploys>
  drivers: () => Tagged<readonly ['hub-drivers'], HubDriver[]>
} = {
  apps: () => tag<HubApp[], readonly ['hub-apps']>(['hub-apps'] as const),
  app: (id) => tag<HubAppFull, readonly ['hub-app', number]>(['hub-app', id] as const),
  envStatus: (envId) =>
    tag<HubEnvStatus, readonly ['hub-env-status', number]>(['hub-env-status', envId] as const),
  deploys: (envId) =>
    tag<HubDeploys, readonly ['hub-env-deploys', number]>(['hub-env-deploys', envId] as const),
  drivers: () => tag<HubDriver[], readonly ['hub-drivers']>(['hub-drivers'] as const)
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export const fetchHubApps = () =>
  api.get<{ data: HubApp[] }>('/hub/apps').then((r) => r.data.data ?? [])

export const fetchHubApp = (id: number) =>
  api.get<{ data: HubAppFull }>(`/hub/apps/${id}`).then((r) => r.data.data)

export const fetchEnvStatus = (envId: number, fresh = false) =>
  api
    .get<{ data: HubEnvStatus }>(
      `/hub/environments/${envId}/status`,
      fresh ? { params: { fresh: 1 } } : undefined
    )
    .then((r) => r.data.data)

export const fetchDeploys = (envId: number) =>
  api
    .get<HubDeploys>(`/hub/environments/${envId}/deploys`, { params: { limit: 20 } })
    .then((r) => ({ data: r.data.data ?? [], reason: r.data.reason }))

export const fetchDrivers = () =>
  api.get<{ data: HubDriver[] }>('/hub/drivers').then((r) => r.data.data ?? [])

export function useHubApp(id: number | null) {
  return useQuery({
    queryKey: hubKeys.app(id ?? 0),
    queryFn: () => fetchHubApp(id as number),
    enabled: id != null
  })
}

/** One environment's status; the server keeps it 30 s, so a minute here is plenty. */
export function useEnvStatus(envId: number) {
  return useQuery({
    queryKey: hubKeys.envStatus(envId),
    queryFn: () => fetchEnvStatus(envId),
    staleTime: 30_000,
    refetchInterval: 60_000
  })
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

export const STATUS_COPY: Record<HubStatusState, string> = {
  ok: 'Running',
  degraded: 'Running with warnings',
  unreachable: 'Not answering',
  link_refused: 'Hub link refused — check HUB_TOKEN'
}

/** Chip colours per status, light + dark (opaque pairs, no bare light backgrounds). */
export const STATUS_TONE: Record<HubStatusState | 'checking', string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  degraded:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
  unreachable:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300',
  link_refused:
    'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300',
  checking:
    'border-slate-200 bg-slate-50 text-slate-500 dark:border-border dark:bg-muted dark:text-muted-foreground'
}

export const STATUS_DOT: Record<HubStatusState | 'checking', string> = {
  ok: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  unreachable: 'bg-red-500',
  link_refused: 'bg-violet-500',
  checking: 'bg-slate-300 dark:bg-slate-600'
}

const CODE_COPY: Record<string, { title: string; hint?: string }> = {
  KEY_TAKEN: { title: 'Another app already uses this key', hint: 'Pick a different key.' },
  HAS_ENVIRONMENTS: {
    title: 'This app still has environments',
    hint: 'Remove its environments first, then delete the app.'
  },
  IN_USE: {
    title: 'An environment still uses this driver',
    hint: 'Move those environments to another driver (or none) first.'
  },
  HUB_NEEDS_ENCRYPTION_KEY: {
    title: 'The Hub cannot store tokens yet',
    hint: 'Set ENCRYPTION_KEY on the Hub server, restart it, then try again.'
  },
  SECRET_REQUIRED: {
    title: 'Enter the token again when the GitLab address or project changes'
  },
  GITLAB_UNREACHABLE: {
    title: 'GitLab did not answer',
    hint: "Check the driver's API URL, project and token."
  }
}

/** describeError with the Hub's own refusals in plain words. */
export function hubError(err: unknown, fallback: string): ErrorDescription {
  const d = describeError(err, fallback)
  const copy = d.code ? CODE_COPY[d.code] : undefined
  if (!copy) return d
  const out: ErrorDescription = { ...d, title: copy.title }
  if (copy.hint) out.hint = copy.hint
  else delete out.hint
  return out
}

/**
 * An error toast with the Hub's refusals in plain words. `title` keeps the caller's own title
 * (e.g. a count) and takes only the hint and action from the error.
 */
export function hubToast(err: unknown, fallback: string, opts: { title?: string } = {}) {
  const d = hubError(err, fallback)
  toast.error(opts.title ?? d.title, errorToastOptions(d))
}
