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
  /** Phase 2: the Hub may promote and roll back this environment (default off). */
  hub_managed?: boolean
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
  /** Ids of the app's failing preflight checks (hub link only). */
  failing?: string[]
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

/** A Docker driver's config (phase 4): the Hub agent's address and how names reach the edge. */
export interface HubDockerDriverConfig {
  agent_url: string
  dns_mode: 'automatic' | 'manual'
  wildcard_domain: string | null
  edge_target: string | null
}

export interface HubDriver {
  id: number
  kind: 'gitlab' | 'docker'
  name: string
  /** GitLab drivers carry the GitLab fields, Docker drivers the Docker ones (never both). */
  config: Partial<HubDriverConfig> & Partial<HubDockerDriverConfig>
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
  components: (placementId: number) => Tagged<readonly ['hub-components', number], HubComponent[]>
  promotable: (envId: number) => Tagged<readonly ['hub-promotable', number], HubPromotable>
  plan: (
    envId: number,
    kind: PromotionKind,
    version: string
  ) => Tagged<readonly ['hub-promote-plan', number, PromotionKind, string], PromotionPlan>
  promotions: (envId: number) => Tagged<readonly ['hub-promotions', number], HubPromotion[]>
  promotion: (id: number) => Tagged<readonly ['hub-promotion', number], HubPromotionDetail>
} = {
  apps: () => tag<HubApp[], readonly ['hub-apps']>(['hub-apps'] as const),
  app: (id) => tag<HubAppFull, readonly ['hub-app', number]>(['hub-app', id] as const),
  envStatus: (envId) =>
    tag<HubEnvStatus, readonly ['hub-env-status', number]>(['hub-env-status', envId] as const),
  deploys: (envId) =>
    tag<HubDeploys, readonly ['hub-env-deploys', number]>(['hub-env-deploys', envId] as const),
  drivers: () => tag<HubDriver[], readonly ['hub-drivers']>(['hub-drivers'] as const),
  components: (placementId) =>
    tag<HubComponent[], readonly ['hub-components', number]>([
      'hub-components',
      placementId
    ] as const),
  promotable: (envId) =>
    tag<HubPromotable, readonly ['hub-promotable', number]>(['hub-promotable', envId] as const),
  plan: (envId, kind, version) =>
    tag<PromotionPlan, readonly ['hub-promote-plan', number, PromotionKind, string]>([
      'hub-promote-plan',
      envId,
      kind,
      version
    ] as const),
  promotions: (envId) =>
    tag<HubPromotion[], readonly ['hub-promotions', number]>(['hub-promotions', envId] as const),
  promotion: (id) =>
    tag<HubPromotionDetail, readonly ['hub-promotion', number]>(['hub-promotion', id] as const)
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

/** Why an environment shows what it shows, by the status read's error code. */
const STATUS_HINT: Record<string, string> = {
  HUB_LINK_MISSING: 'The app has no HUB_TOKEN',
  HUB_LINK_REFUSED: "Token does not match the app's HUB_TOKEN",
  HUB_LINK_REDIRECT: 'The address redirects — use the final https address',
  HUB_SECRET_UNREADABLE: "Saved token can't be read — enter it again",
  HUB_SECRET_NOT_SEALED: "Saved token can't be read — enter it again",
  TIMEOUT: 'No answer',
  UNREACHABLE: 'No answer',
  BAD_BASE_URL: 'Address is not valid'
}

/** One short line on why a status is not fine, or null when there is nothing to add. */
export function statusHint(s: HubEnvStatus): string | null {
  const byCode = s.error ? STATUS_HINT[s.error] : undefined
  if (byCode) return byCode
  if (s.failing?.length) return `Failing checks: ${s.failing.join(', ')}`
  return null
}

/** Chip colours per status, light + dark (opaque pairs, no bare light backgrounds). */
/** A chip's state: a status the Hub read, still checking, or the Hub's own read failed. */
export type ChipState = HubStatusState | 'checking' | 'failed'

export const STATUS_TONE: Record<ChipState, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
  degraded:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300',
  unreachable:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300',
  link_refused:
    'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900/60 dark:bg-violet-950/40 dark:text-violet-300',
  checking:
    'border-slate-200 bg-slate-50 text-slate-500 dark:border-border dark:bg-muted dark:text-muted-foreground',
  failed:
    'border-orange-200 bg-orange-50 text-orange-800 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300'
}

export const STATUS_DOT: Record<ChipState, string> = {
  ok: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  unreachable: 'bg-red-500',
  link_refused: 'bg-violet-500',
  checking: 'bg-slate-300 dark:bg-slate-600',
  failed: 'bg-orange-500'
}

const CODE_COPY: Record<string, { title: string; hint?: string }> = {
  // X-6b: the environment's lock names who holds it (a promotion is PROMOTION_RUNNING).
  CREATION_RUNNING: {
    title: 'A creation step is running on this environment',
    hint: 'Wait for it to finish, or cancel it on the app page, then try again.'
  },
  // X-7: hub token input rules
  HUB_TOKEN_MASK: {
    title: 'That is the hidden token, not a token',
    hint: 'Type the new token, or leave the field as it was to keep the stored one.'
  },
  HUB_TOKEN_TOO_SHORT: {
    title: 'The hub token is too short',
    hint: 'Use at least 32 characters, the same token the app has as HUB_TOKEN.'
  },
  STACK_BUSY: {
    title: 'A stack restart or removal is running on this environment',
    hint: 'Wait for it to finish, then try again.'
  },
  CONFIRM_REQUIRED: {
    title: "Type the environment's name to confirm",
    hint: 'Nothing was started. Type the name exactly as shown, then start again.'
  },
  BAD_KIND: { title: 'Pick what the component is', hint: 'A component is an API or a frontend.' },
  BAD_DRIVER: {
    title: 'That driver does not exist any more',
    hint: 'Pick one of the drivers listed under Drivers.'
  },
  POSITION_TAKEN: {
    title: 'Another component already has that place',
    hint: 'Reload the components and try again.'
  },
  BAD_VERIFY_URL: {
    title: 'The check address is not valid',
    hint: 'Use a full http(s) address, for example https://app.example.com/api/version.'
  },
  KEY_TAKEN: { title: 'Another app already uses this key', hint: 'Pick a different key.' },
  HAS_ENVIRONMENTS: {
    title: 'This app still has environments',
    hint: 'Remove its environments first, then delete the app.'
  },
  IN_USE: {
    title: 'An environment still uses this driver',
    hint: 'Move those environments to another driver (or none) first.'
  },
  PLACEMENT_IN_USE: {
    title: 'Another environment already uses this placement',
    hint: 'Each environment has its own placement. Pick the driver again to make a new one.'
  },
  BAD_SECRET: { title: 'The token must be text', hint: 'Type the token again.' },
  HUB_NEEDS_ENCRYPTION_KEY: {
    title: 'The Hub cannot store tokens yet',
    hint: 'Set ENCRYPTION_KEY on the Hub server, restart it, then try again.'
  },
  SECRET_REQUIRED: {
    title: 'Enter the token again',
    hint: 'The address changed, so the saved token is not sent to it. Type the token again or clear it.'
  },
  GITLAB_UNREACHABLE: {
    title: 'GitLab did not answer',
    hint: "Check the driver's API URL, project and token."
  },
  LOCK_UNAVAILABLE: {
    title: 'The Hub cannot make sure only one promotion runs right now',
    hint: 'It cannot reach Redis. Nothing was started. Try again in a moment.'
  },
  PLAN_HASH_REQUIRED: {
    title: 'Check the plan before you start',
    hint: 'A start must carry the plan you checked. Read the plan again, then start.'
  },
  NOT_RUNNING: {
    title: 'That promotion is not running any more',
    hint: 'It already finished, failed or was stopped. Reload to see how it ended.'
  },
  GITLAB_UNAUTHORIZED: {
    title: "GitLab did not accept the driver's token",
    hint: 'The token is wrong or expired. A Hub admin enters a new one on the driver.'
  },
  GITLAB_FORBIDDEN: {
    title: "The driver's token may not do this in GitLab",
    hint: 'Give the token the api scope and enough rights on the project (merging into the target branch included).'
  },
  GITLAB_NO_TOKEN: {
    title: 'The driver has no GitLab token',
    hint: 'A Hub admin adds a token to the driver.'
  },
  DRIVER_MISCONFIGURED: {
    title: 'The driver is not set up completely',
    hint: 'A Hub admin checks its GitLab address, project, branch, pin file and deploy job.'
  },
  CI_CONFIG_REFUSED: {
    title: "The app's deploy repository no longer runs the Hub's deploy job",
    hint: 'Its CI configuration path or pipeline-variable setting was changed in GitLab, so the Hub stopped before writing anything. A Hub admin saves the target again to put the settings back, then plans and starts again.'
  },
  DRIVER_CHANGED: {
    title: 'A driver was changed while this ran',
    hint: 'It now points at another repository than when the run started, so the Hub stopped. Check the driver, then plan and start again.'
  },
  ROLLBACK_NOT_RECORDED: {
    title: 'The Hub did not record the build this version deployed',
    hint: 'A rollback reruns the exact build the Hub deployed; without that record it cannot roll back to this version. A portal this run already rolled back stays on the older build: roll back again or promote.'
  },
  ROLLBACK_BUILD_UNKNOWN: {
    title: 'The Hub has no record of the build this version deployed, so it cannot redeploy it.',
    hint: 'Roll back only to a version the Hub deployed here itself. Nothing was changed.'
  },
  REDEPLOY_REFUSED_BY_GITLAB: {
    title: 'GitLab refused to rerun the deploy job',
    hint: 'The environment runs an older build (after a rollback), so the Hub reran this version\'s deploy job, and GitLab refused. Check the project\'s "Prevent outdated deployment jobs" setting, or run the deploy job by hand.'
  },
  ROLLBACK_REFUSED_BY_GITLAB: {
    title: 'GitLab refused to rerun the earlier deploy job',
    hint: 'The project\'s "Prevent outdated deployment jobs" setting refuses an older deploy job. Allow job retries for rollback deployments in GitLab\'s CI/CD settings, or roll back by hand. A portal this run already rolled back stays on the older build.'
  }
}

/** describeError with the Hub's own refusals in plain words. */
export function hubError(
  err: unknown,
  fallback: string,
  fieldLabels: Record<string, string> = {}
): ErrorDescription {
  const d = describeError(err, fallback)
  const copy = d.code ? (CODE_COPY[d.code] ?? BLOCKER_COPY[d.code]) : undefined
  if (!copy) return d
  const out: ErrorDescription = { ...d, title: copy.title }
  if (copy.hint) out.hint = copy.hint
  else delete out.hint
  // A refused edit names the field it refused (STACK_RUNNING carries `field`).
  const field = (err as { response?: { data?: { field?: unknown } } })?.response?.data?.field
  if (d.code === 'STACK_RUNNING' && typeof field === 'string') {
    const label = fieldLabels[field] ?? STACK_FIELD_LABELS[field] ?? `the ${field}`
    out.hint = `Changing ${label} would lose the stack. Use Remove stack… in its stack panel first, then change it.`
  }
  return out
}

const STACK_FIELD_LABELS: Record<string, string> = {
  key: 'the key',
  placement_id: 'the placement'
}

/**
 * An error toast with the Hub's refusals in plain words. `title` keeps the caller's own title
 * (e.g. a count) and takes only the hint and action from the error.
 */
export function hubToast(
  err: unknown,
  fallback: string,
  opts: { title?: string; fieldLabels?: Record<string, string> } = {}
) {
  const d = hubError(err, fallback, opts.fieldLabels)
  toast.error(opts.title ?? d.title, errorToastOptions(d))
}

// ─── Phase 2: components, promote and roll back ───────────────────────────────

export type ComponentKind = 'api' | 'frontend' | 'stack'
export type PromotionKind = 'promote' | 'rollback'

/** One ordered piece of an environment's placement, each deployed through its own driver. */
export interface HubComponent {
  /** null for the implicit component of a placement with none stored (phase-1 placement). */
  id: number | null
  placement_id: number
  position: number
  name: string
  kind: ComponentKind
  driver_id: number
  source_branch: string
  /** null = the driver's branch. */
  target_branch: string | null
  before_job: string | null
  /** null = the driver's deploy job. */
  deploy_job: string | null
  verify_url: string | null
  verify_field: string
  /** True when nothing is stored and the placement's own driver stands in as one api component. */
  implicit?: boolean
}

export interface HubPromotable {
  /** Versions the previous environment runs or deployed, newer than this one's. */
  promote: string[]
  /**
   * Older versions the Hub deployed here successfully, with every component's build recorded
   * (never versions from before the Hub): a rollback reruns those builds.
   */
  rollback: string[]
  /**
   * The version running here when a Hub promotion of it stopped between components (listed in
   * `promote` too): promoting it again finishes it. null otherwise.
   */
  finish?: string | null
  /** The environment promotions here come from; null = this is the first environment. */
  previous?: string | null
}

export interface PromotionBlocker {
  code: string
  text: string
}

export interface PromotionStep {
  position: number
  component: string
  kind: ComponentKind
  sourceSha: string | null
  targetBranch: string
  pinText: string | null
  beforeJob: string | null
  deployJob: string
  verifyUrl: string | null
  want: string
  /** Phase 4: the executor; absent = GitLab (merge + deploy job), docker = the Hub agent. */
  driver?: 'gitlab' | 'docker'
  /** Phase 4, docker steps: the stack the Hub deploys (never a setting or a secret). */
  stack?: { name: string; image?: string; size?: string }
  /** api: already deployed with this version — nothing is merged or deployed. */
  noop?: boolean
  /** rollback: the pipeline whose deploy job is rerun (the recorded build). */
  buildPipelineId?: number | null
  /** Recorded once the deploy passed: the commit its deploy job ran on, and the pipeline. */
  deployedSha?: string | null
  deployedPipelineId?: number | null
}

export interface PromotionPlan {
  ok: boolean
  blockers: PromotionBlocker[]
  lines: string[]
  steps: PromotionStep[]
  /** What a start must send back: it starts only if the plan is still exactly this one. */
  plan_hash?: string
}

export type PromotionStatus =
  | 'planned'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** One Hub promotion or rollback (`nivaro_hub_deploys`). */
export interface HubPromotion {
  id: number
  app_id: number
  environment_id: number
  kind: PromotionKind
  version: string
  from_version: string | null
  status: PromotionStatus
  /** The last step the runner started. */
  step: string | null
  error: string | null
  job_run_id: number | null
  started_by: string | null
  /** The starter's display name, when the API sends it. */
  started_by_name?: string | null
  started_at: string
  finished_at: string | null
  /** Phase 4: an Apply now run (the saved stack settings onto the running version). */
  apply?: boolean
}

export interface HubPromotionLogLine {
  seq: number
  at: string
  level: 'info' | 'warn' | 'error'
  line: string
}

export interface HubPromotionDetail extends HubPromotion {
  /** The plan at start (stored as JSON text; parsed by `promotionPlanOf`). */
  plan: PromotionPlan | string | null
  log: HubPromotionLogLine[]
}

export const fetchComponents = (placementId: number) =>
  api
    .get<{ data: HubComponent[] }>(`/hub/placements/${placementId}/components`)
    .then((r) => r.data.data ?? [])

export const fetchPromotable = (envId: number) =>
  api.get<{ data: HubPromotable }>(`/hub/environments/${envId}/promotable`).then(
    (r): HubPromotable => ({
      promote: r.data.data?.promote ?? [],
      rollback: r.data.data?.rollback ?? [],
      finish: r.data.data?.finish ?? null,
      // undefined (an older API): not known whether there is an environment before this one.
      previous: r.data.data?.previous
    })
  )

export const fetchPromotionPlan = (envId: number, kind: PromotionKind, version: string) =>
  api
    .post<{ data: PromotionPlan }>(`/hub/environments/${envId}/promote/plan`, { version, kind })
    .then((r) => r.data.data)

export const startPromotion = (
  envId: number,
  body: { version: string; kind: PromotionKind; confirm: string; plan_hash: string }
) =>
  api
    .post<{ data: { deploy_id: number; job_run_id: number | null } }>(
      `/hub/environments/${envId}/promote`,
      body
    )
    .then((r) => r.data.data)

export const fetchPromotions = (envId: number) =>
  api
    .get<{ data: HubPromotion[] }>(`/hub/environments/${envId}/deploys/hub`, {
      params: { limit: 20 }
    })
    .then((r) => r.data.data ?? [])

export const fetchPromotion = (id: number) =>
  api
    .get<{ data: HubPromotionDetail }>(`/hub/promotions/${id}`)
    .then((r) => ({ ...r.data.data, log: r.data.data?.log ?? [] }))

export const cancelPromotion = (id: number) => api.post(`/hub/promotions/${id}/cancel`, {})

/** The plan stored on a promotion, whether the API sent it parsed or as JSON text. */
export function promotionPlanOf(d: { plan?: PromotionPlan | string | null }): PromotionPlan | null {
  if (!d.plan) return null
  if (typeof d.plan !== 'string') return d.plan
  try {
    return JSON.parse(d.plan) as PromotionPlan
  } catch {
    return null
  }
}

/** The blockers a refused start (409) carried, if any. */
export function blockersOf(err: unknown): PromotionBlocker[] {
  const body = (err as { response?: { data?: { blockers?: unknown } } })?.response?.data
  return Array.isArray(body?.blockers) ? (body.blockers as PromotionBlocker[]) : []
}

/** The plan a start refused with 409 PLAN_CHANGED carried (the plan as it stands now). */
export function changedPlanOf(err: unknown): PromotionPlan | null {
  const res = (err as { response?: { status?: number; data?: { code?: unknown; plan?: unknown } } })
    ?.response
  if (res?.data?.code !== 'PLAN_CHANGED') return null
  const plan = res.data.plan as PromotionPlan | undefined
  return plan && Array.isArray(plan.steps) ? plan : null
}

/** Why a promotion or rollback cannot start, in plain words (by planner code). */
export const BLOCKER_COPY: Record<string, { title: string; hint?: string }> = {
  NOT_HUB_MANAGED: {
    title: 'The Hub does not deploy this environment yet',
    hint: "A Hub admin turns on 'The Hub deploys this environment' in its settings."
  },
  PROMOTION_RUNNING: {
    title: 'A promotion is already running here',
    hint: 'Wait for it to finish, or cancel it, then try again.'
  },
  NO_PREVIOUS_ENVIRONMENT: {
    title: 'This is the first environment, so there is nothing to promote from',
    hint: 'New versions reach it through its own pipeline.'
  },
  PREVIOUS_NEVER_RAN: {
    title: 'The environment before this one has not run this version',
    hint: 'Promote it there first.'
  },
  ALREADY_RUNS: {
    title: 'This environment already runs this version',
    hint: 'To deploy changed stack settings or extension pins to a Docker environment, use Apply now in its stack panel.'
  },
  OLDER_THAN_CURRENT: {
    title: 'This version is older than the one running here',
    hint: 'Use Roll back to go to an older version.'
  },
  NOT_DEPLOYED_BEFORE: {
    title: 'This environment never ran this version',
    hint: 'You can roll back only to a version that deployed here successfully.'
  },
  NO_SOURCE_COMMIT: {
    title: 'No release commit for this version on the source branch',
    hint: "The release must land on the deploy repository's source branch first."
  },
  FRONTEND_UNKNOWN: {
    title: 'Cannot tell which frontend the environment before this one serves',
    hint: 'Its check address must answer with a version.'
  },
  IMAGE_MISSING: {
    title: 'The image for this version is not published',
    hint: 'Publish the release first, then try again.'
  },
  IMAGE_NO_DIGEST: {
    title: 'The image for this version has no digest to pin',
    hint: 'Publish the release again so the registry records its digest.'
  },
  NO_COMPONENTS: {
    title: 'Nothing to deploy: this environment has no components',
    hint: "A Hub admin adds a driver or components in the environment's settings."
  },
  BAD_VERSION: {
    title: 'That is not a version number',
    hint: 'Versions look like 0.3.210.'
  },
  NO_DRIVER: {
    title: 'A component has no driver to deploy it',
    hint: "A Hub admin picks a driver for it in the environment's components."
  },
  FRONTEND_NOT_ON_SOURCE: {
    title: 'The frontend the environment before this one serves is not on the source branch',
    hint: 'Merge that frontend commit into the source branch, then try again.'
  },
  FRONTEND_ROLLBACK_NO_BUILD: {
    title: 'The frontend build for that version cannot be redeployed',
    hint: 'Its commit is no longer on the branch, GitLab no longer has the build, or its deploy job cannot run again. Nothing was changed.'
  },
  ROLLBACK_NO_BUILD: {
    title: 'The API build for that version cannot be redeployed',
    hint: 'Its commit is no longer on the branch, GitLab no longer has the build, or its deploy job cannot run again. Nothing was changed.'
  },
  ROLLBACK_NOT_RECORDED: {
    title: 'The Hub did not record the build this version deployed',
    hint: 'A rollback reruns the exact build the Hub deployed. Without that record it cannot roll back to this version. Nothing was changed.'
  },
  HEAD_UNKNOWN: {
    title: 'GitLab did not say which commit the target branch points at',
    hint: 'The Hub deploys only a head it names in the plan. Check the branch in GitLab, then plan again.'
  },
  PIN_CHANGED: {
    title: 'The image for this version changed since it was deployed here',
    hint: 'The Hub never rewrites the pin of the version that is running. Publish a new version instead.'
  }
}

/** One blocker in plain words; an unknown code keeps the planner's own text. */
export function blockerCopy(b: PromotionBlocker): { title: string; hint?: string } {
  return BLOCKER_COPY[b.code] ?? CODE_COPY[b.code] ?? { title: b.text || 'This cannot start yet' }
}

const PROMOTION_STATUS_WORDS: Record<PromotionStatus, string> = {
  planned: 'Planned',
  running: 'Running',
  success: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted'
}

const PROMOTION_STATUS_TONE: Record<PromotionStatus, string> = {
  planned: 'text-slate-600 dark:text-slate-300',
  running: 'text-sky-700 dark:text-sky-300',
  success: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-red-700 dark:text-red-300',
  cancelled: 'text-slate-600 dark:text-slate-300',
  interrupted: 'text-amber-800 dark:text-amber-300'
}

const KNOWN_STATUS = new Set<string>(Object.keys(PROMOTION_STATUS_WORDS))

/** A status in words; one this screen does not know shows as the server sent it. */
export const promotionStatusWords = (s: string): string =>
  KNOWN_STATUS.has(s) ? PROMOTION_STATUS_WORDS[s as PromotionStatus] : s || 'Unknown'

export const promotionStatusTone = (s: string): string =>
  KNOWN_STATUS.has(s)
    ? PROMOTION_STATUS_TONE[s as PromotionStatus]
    : 'text-slate-600 dark:text-slate-300'

/**
 * Still going: planned or running — and any status this screen does not know, so a view of a
 * running promotion never freezes on a word added later.
 */
export const isLivePromotion = (s: string) =>
  s === 'running' || s === 'planned' || !KNOWN_STATUS.has(s)

/** Phase 4: why a Docker stack deploy cannot start, in plain words (by planner code). */
Object.assign(BLOCKER_COPY, {
  AGENT_UNREACHABLE: {
    title: 'The Hub agent on the Docker host does not answer',
    hint: "Check that the agent runs and that the driver's agent address is right."
  },
  AGENT_REFUSED: {
    title: 'The Hub agent refused the Hub',
    hint: "A Hub admin enters the agent's token again in the Docker driver."
  },
  AGENT_INCOMPATIBLE: {
    title: 'The Hub agent is a version this Hub cannot talk to',
    hint: 'Update the Hub agent (or the Hub) so both speak the same agent API.'
  },
  IMAGE_NOT_ALLOWED: {
    title: 'The Hub agent does not allow the Nivaro image',
    hint: "Add the image to the agent's allowed images (HUB_AGENT_IMAGES)."
  },
  EXTENSION_NOT_ALLOWED: {
    title: 'The Hub agent does not allow an extension image',
    hint: "Add the extension's image to the agent's allowed images (HUB_AGENT_IMAGES)."
  },
  EXTENSION_UNPINNED: {
    title: 'An extension this app needs has no pinned image',
    hint: 'Pin the extension on the environment the version comes from, then try again.'
  },
  STACK_SETTINGS_MISSING: {
    title: 'The stack settings are not complete',
    hint: "A Hub admin fills in the missing settings in the environment's stack settings."
  },
  STACK_SETTINGS_INVALID: {
    title: 'The stack settings cannot make a stack the agent accepts',
    hint: "A Hub admin fixes the environment's stack settings."
  },
  HOSTNAME_NOT_ALLOWED: {
    title: 'A name of this environment cannot be routed by this Docker host',
    hint: "Use names under the driver's DNS domain and the agent's allowed domains."
  },
  HOSTNAME_TAKEN: {
    title: 'A name of this environment already belongs to another environment',
    hint: 'Give this environment its own names.'
  },
  PUBLISH_PORT_NOT_ALLOWED: {
    title: 'The stack needs a publish port inside the agent’s range',
    hint: "A Hub admin sets a free publish port from the agent's range in the stack settings."
  },
  TEMPLATE_NONE: {
    title: 'This version is too old to run as a Docker stack',
    hint: 'Pick a newer version.'
  },
  STACK_NOT_HUB: {
    title: 'A stack with this name already runs on the Docker host and is not this environment’s',
    hint: "Give the environment's placement a stack name nothing else uses."
  },
  NO_STACK_NAME: {
    title: 'The environment has no stack name',
    hint: "A Hub admin sets the stack name in the environment's placement."
  },
  KIND_DRIVER_MISMATCH: {
    title: 'A component is on the wrong kind of driver',
    hint: 'Stacks deploy through a Docker driver; api and frontend components through GitLab.'
  }
} satisfies Record<string, { title: string; hint?: string }>)

/** Phase 4 (docker plan, run step and stack routes): refusals and failures in plain words. */
Object.assign(BLOCKER_COPY, {
  STACK_OWNER_MISMATCH: {
    title: 'This stack belongs to another environment',
    hint: "Give this environment's placement a stack name no other app uses."
  },
  STACK_LEFTOVERS: {
    title: 'Parts of an older stack with this name are still on the Docker host',
    hint: 'Use Remove stack… in its stack panel to clear them, then delete the environment.'
  },
  STACK_NAME_TAKEN: {
    title: 'Another environment already uses this stack name',
    hint: 'Give each environment its own stack name.'
  },
  NOT_DEPLOYED: {
    title: 'The stack is not deployed yet',
    hint: 'Deploy a version first.'
  },
  SPEC_MISMATCH: {
    title: 'The stack does not run what the Hub has on record',
    hint: 'Saved settings or pins changed since the last deploy. Use Apply now to deploy them, then restart if needed.'
  },
  MIXED_DRIVER_KINDS: {
    title: 'A placement deploys through one kind of driver',
    hint: 'Keep GitLab components and Docker stacks on separate placements.'
  },
  ONE_STACK: {
    title: 'A Docker placement deploys exactly one stack',
    hint: 'Remove the extra component, or use another placement.'
  },
  ENV_NOT_ALLOWED: {
    title: 'The agent does not allow that setting name',
    hint: 'Use a Nivaro setting, or a name under a prefix the agent allows (HUB_AGENT_ENV_PREFIXES).'
  },
  STACK_STATE_UNKNOWN: {
    title: 'The Hub cannot tell whether the stack runs',
    hint: 'The Docker host did not answer clearly. Check the agent, then try again.'
  },
  STACK_RUNNING: {
    title: 'A stack the Hub deployed runs on this',
    hint: 'Changing it would lose the stack. Use Remove stack… in its stack panel first, then change it.'
  },
  STACK_STILL_RUNNING: {
    title: 'The stack still runs',
    hint: 'Use Remove stack… in its stack panel first, then delete the environment.'
  },
  NOT_WAITING_FOR_NAME: {
    title: 'This deploy is not waiting for a name',
    hint: 'Only a deploy that finished and waits for DNS can check a name.'
  },
  TOO_SOON: {
    title: 'That was checked a moment ago',
    hint: 'Wait a few seconds, then check again.'
  },
  OWNER_REQUIRED: {
    title: 'Only an owner of this app or a Hub admin can do this',
    hint: 'Ask an owner of the app.'
  },
  PREFLIGHT_FAILED: {
    title: 'The new version started but its checks fail',
    hint: "Open the app's preflight list, fix what fails, then deploy again."
  },
  VERIFY_FAILED: {
    title: 'The new version never answered',
    hint: 'The stack runs, but its address did not report this version. Check the names and the logs.'
  },
  SWARM_ROLLED_BACK: {
    title: 'Docker rolled the stack back to the version before',
    hint: 'The new version could not start. Read the stack log, fix it, then deploy again.'
  },
  STACK_DEPLOY_TIMEOUT: {
    title: 'The stack did not settle in time',
    hint: 'It may still be starting. Check the stack, then deploy again if it stays stuck.'
  },
  NOT_DOCKER: {
    title: 'That driver is not a Docker driver',
    hint: 'Pick a driver of kind Docker.'
  },
  SETTING_INVALID: {
    title: 'A stack setting has a value the stack cannot use',
    hint: 'Check this entry. Names ending in _FILE and reserved names are not allowed here.'
  },
  HOSTNAME_INVALID: {
    title: 'A name of this environment is not a valid host name',
    hint: 'Use lower-case letters, digits, dots and dashes.'
  },
  HOSTNAME_NOT_UNDER_WILDCARD: {
    title: "A name is not under the driver's wildcard domain",
    hint: "Use a name that ends with the driver's wildcard domain, or switch the driver to manual DNS."
  },
  TOO_MANY_HOSTNAMES: {
    title: 'This environment has too many names',
    hint: 'Remove names it does not need.'
  },
  AGENT_REDIRECT: {
    title: 'The agent address redirects somewhere else',
    hint: "Use the agent's own address, not one that redirects."
  },
  NOT_RUNNING: {
    title: 'The stack is not running',
    hint: 'Deploy a version first.'
  },
  BAD_CONFIG: {
    title: 'The driver settings are not complete',
    hint: 'Fill in the Agent URL, and the wildcard domain (automatic) or edge target (manual).'
  },
  BAD_NAME: {
    title: 'Give it a name',
    hint: 'The name cannot be empty or too long.'
  },
  BAD_STACK_NAME: {
    title: 'That is not a valid stack name',
    hint: 'Lower-case letters, digits and dashes.'
  }
} satisfies Record<string, { title: string; hint?: string }>)

/** The codes the Hub's own (non-planner) refusals have copy for (a test checks coverage). */
export const CODE_COPY_KEYS: ReadonlySet<string> = new Set(Object.keys(CODE_COPY))

/** Codes whose planner text names things the person must see (setting or host names — never values). */
const DETAIL_CODES = new Set([
  'STACK_SETTINGS_MISSING',
  'STACK_SETTINGS_INVALID',
  'HOSTNAME_NOT_ALLOWED',
  'HOSTNAME_TAKEN',
  'PUBLISH_PORT_NOT_ALLOWED',
  'IMAGE_NOT_ALLOWED',
  'EXTENSION_NOT_ALLOWED',
  'EXTENSION_UNPINNED'
])

/** The planner's own sentence for a blocker whose names matter (e.g. which settings are missing). */
export const blockerDetail = (b: PromotionBlocker): string | null =>
  DETAIL_CODES.has(b.code) && b.text.trim() ? b.text.trim() : null

/**
 * The detail line under a blocker's plain words: the planner's sentence, unless it only repeats
 * the title. Agent refusals (AGENT_*) stay in plain words only: their sentence names addresses
 * the person cannot act on; the names-bearing phase-4 codes (blockerDetail) always show it.
 */
export const blockerDetailLine = (b: PromotionBlocker, title: string): string | null => {
  const text = b.text?.trim()
  if (!text || text === title) return null
  if (DETAIL_CODES.has(b.code)) return text
  return b.code.startsWith('AGENT_') ? null : text
}

/** Phase 4: the promotable versions plus whether the published releases could be read. */
export interface HubPromotableReleases extends HubPromotable {
  /** The first environment of an all-stack app lists published releases; true = unreadable. */
  releases_error: boolean
}

export const fetchPromotableReleases = (envId: number): Promise<HubPromotableReleases> =>
  api
    .get<{ data: Partial<HubPromotableReleases> }>(`/hub/environments/${envId}/promotable`)
    .then((r) => ({
      promote: r.data.data?.promote ?? [],
      rollback: r.data.data?.rollback ?? [],
      finish: r.data.data?.finish ?? null,
      // undefined (an older API): not known whether there is an environment before this one.
      previous: r.data.data?.previous,
      releases_error: r.data.data?.releases_error === true
    }))

export const RELEASES_ERROR_TEXT =
  "Couldn't read the published releases, so none of them are listed. Try again in a moment."

/** Phase 4 (stack panel): refusals the settings, restart, remove and name-check routes add. */
Object.assign(BLOCKER_COPY, {
  ADMIN_ONLY: {
    title: 'Only a Hub administrator can do this',
    hint: 'Ask an administrator of this Hub.'
  },
  AGENT_ERROR: {
    title: 'The Hub agent could not do that',
    hint: 'Check the agent, then try again.'
  },
  ENGINE_ERROR: {
    title: 'Docker on the host could not do that',
    hint: 'Check the Docker host, then try again.'
  },
  SECRET_IN_SETTINGS: {
    title: 'That looks like a credential',
    hint: 'Put it under Secrets, not Settings.'
  },
  RESERVED_SETTING: {
    title: 'The Hub sets that name itself',
    hint: 'Remove it from the stack settings.'
  },
  BAD_KEY: { title: 'A name is not valid', hint: 'Use A–Z, 0–9 and _ (upper case).' },
  BAD_VALUE: { title: 'A value is not valid', hint: 'Check this value.' },
  BAD_SIZE: { title: 'Pick small, medium or large' },
  BAD_REDIS: { title: 'Pick bundled or external Redis' },
  BAD_PUBLISH_PORT: { title: 'The publish port must be a port number (1–65535)' },
  BAD_DB_CLIENT: { title: 'That database client is not one Nivaro boots with' },
  SQLITE_ONE_PROCESS: {
    title: 'SQLite needs size small',
    hint: 'SQLite is one file one process can write.'
  },
  BAD_EXTENSION_PIN: {
    title: 'An extension pin is not valid',
    hint: 'Use image@sha256:… with the 64-character digest.'
  }
} satisfies Record<string, { title: string; hint?: string }>)

// ─── Phase 6: shared deployments (the Shared deployments tab, pages/hub/shared) ──────────────
// Types only: shared/shared-api imports hubError from here, so a runtime re-export would make a
// cycle. Screens that need the fetchers or keys import shared/shared-api directly.

export type {
  SharedAppRow,
  SharedDeployment,
  SharedDetail,
  SharedListRow,
  SharedMode
} from './shared/shared-api'

// ─── Phase 6: shared placements, moves ───────────────────────────────────────

/** A Hub deploy row's kind: phase 6 adds the mirror rows of a move and of a shared upgrade. */
export type HubDeployKind = PromotionKind | 'move' | 'shared'

/** Why a promotion, a stack change or a creation step refuses a shared-placed environment. */
export const SHARED_PLACEMENT_TIP =
  'Runs on a shared deployment, so its version follows the deployment. Upgrade the shared deployment instead.'

Object.assign(BLOCKER_COPY, {
  SHARED_PLACEMENT: {
    title: 'This environment runs on a shared deployment',
    hint: 'Its version follows the deployment. Upgrade the shared deployment instead (Apps hub → Shared deployments).'
  },
  USE_MOVE: {
    title: 'This change needs a move',
    hint: 'An environment goes onto or off a shared deployment only through Move….'
  },
  // Task 5: a warning on an environment's stack plan (HUB_URL on this Hub is not usable).
  HUB_URL_PROBLEM: {
    title: "The Hub's own address is not one an app can use",
    hint: 'Set HUB_URL on the Hub to its https address (no path), restart the Hub, then plan again.'
  },
  PLACEMENT_CHANGED: {
    title: "The environment's placement changed meanwhile",
    hint: 'Nothing was changed. Reload, check where it runs now, then try again.'
  }
} satisfies Record<string, { title: string; hint?: string }>)

/** A Hub deploy row's kind in words (history): `move` = "Moved", `shared` = "Shared upgrade". */
export function deployKindWords(r: { kind: string; apply?: boolean }): string {
  if (r.apply) return 'Apply settings'
  switch (r.kind) {
    case 'promote':
      return 'Promote'
    case 'rollback':
      return 'Rollback'
    case 'move':
      return 'Moved'
    case 'shared':
      return 'Shared upgrade'
    default:
      return r.kind
  }
}

/** Promotions and rollbacks are watched and rolled back here; move and shared rows are not. */
export const isPromotionKind = (k: string): k is PromotionKind =>
  k === 'promote' || k === 'rollback'

/**
 * A delete refused because the Hub could not take or read the environments' locks (Redis down,
 * 503 LOCK_UNAVAILABLE): nothing was deleted. Other refusals keep the Hub's own words.
 */
export function hubDeleteToast(err: unknown, fallback: string) {
  const d = hubError(err, fallback)
  if (d.code === 'LOCK_UNAVAILABLE') {
    d.title = 'Nothing was deleted: the Hub cannot check what is running right now'
    d.hint =
      'It cannot reach Redis to make sure no promotion, move or creation is using this. Try again in a moment.'
  }
  toast.error(d.title, errorToastOptions(d))
}
