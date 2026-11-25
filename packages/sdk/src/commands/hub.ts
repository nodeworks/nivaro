/**
 * Nivaro Hub client (Hub mode only) — `nivaro.hub.*`.
 *
 * These calls reach /api/hub/*, which exists ONLY on a Nivaro Hub (a deployment with HUB=on). A
 * regular install has none of these routes: the first Hub call asks GET /api/app-info once (per
 * client) whether `hub` is among the server's features, and every Hub call on a server that is not
 * a Hub fails with a NivaroError coded `HUB_MODE_OFF` instead of a bare 404.
 *
 * Access is the server's: administrators see everything, app owners their own apps (another app
 * answers 404). A named API key needs the `hub:read` scope (reads and plans) or `hub:write`
 * (changes); `*` does not include the Hub. Connected apps (OAuth / MCP) only read and plan.
 */
import { type Command, cmd } from '../command.js'
import { NivaroError } from '../errors.js'

export interface HubApp {
  id: number
  key: string
  name: string
  signin_mode: 'direct' | 'hub'
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
  /** Masked (••••••) when one is stored, else null — never the token. */
  hub_token: string | null
  hub_managed: boolean
  on_shared?: boolean
}

export interface HubOwner {
  user_id: string
  name: string
}

export interface HubAppDetail extends HubApp {
  environments: HubEnvironment[]
  owners: HubOwner[]
}

export interface HubEnvStatus {
  state: 'ok' | 'degraded' | 'unreachable' | 'link_refused'
  version: string | null
  preflight: string | null
  checked_at: string
  source: 'hub-link' | 'public' | 'shared'
  error?: string
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
  version: string | null
}

/** A GitLab or Docker driver; `secret` is masked, never the token. */
export interface HubDriver {
  id: number
  kind: 'gitlab' | 'docker'
  name: string
  config: Record<string, unknown>
  secret: string | null
}

/** A promotion, move, shared upgrade or creation run (shape per kind; see the API reference). */
export interface HubRun {
  id: number
  status: string
  [key: string]: unknown
}

/** A plan. `plan_hash` must be sent back with the start call. */
export interface HubPlan {
  plan_hash?: string
  [key: string]: unknown
}

export interface HubShared {
  id: number
  key: string
  mode: 'docker' | 'registered'
  status: string
  apps?: number
  live_replicas?: number | null
  [key: string]: unknown
}

type Data<T> = { data: T }
const p = (v: number | string) => encodeURIComponent(String(v))

/** Command builders for every Hub route the client covers (send with `nivaro.request`). */
export const hubCommands = {
  // Apps and owners
  listApps: (): Command<Data<HubApp[]>> => cmd('GET', '/hub/apps'),
  readApp: (id: number): Command<Data<HubAppDetail>> => cmd('GET', `/hub/apps/${p(id)}`),
  createApp: (body: Partial<HubApp> & { key: string; name: string }): Command<Data<HubApp>> =>
    cmd('POST', '/hub/apps', undefined, body),
  updateApp: (id: number, body: Partial<HubApp>): Command<Data<HubApp>> =>
    cmd('PATCH', `/hub/apps/${p(id)}`, undefined, body),
  deleteApp: (id: number): Command<Data<{ id: number }>> => cmd('DELETE', `/hub/apps/${p(id)}`),
  setAppOwners: (id: number, userIds: string[]): Command<Data<unknown>> =>
    cmd('PUT', `/hub/apps/${p(id)}/owners`, undefined, { user_ids: userIds }),
  appStatus: (
    id: number
  ): Command<Data<Array<{ id: number; key: string | null; status: HubEnvStatus }>>> =>
    cmd('GET', `/hub/apps/${p(id)}/status`),
  // Environments
  addEnvironment: (appId: number, body: Partial<HubEnvironment>): Command<Data<HubEnvironment>> =>
    cmd('POST', `/hub/apps/${p(appId)}/environments`, undefined, body),
  updateEnvironment: (
    envId: number,
    body: Partial<HubEnvironment>
  ): Command<Data<HubEnvironment>> =>
    cmd('PATCH', `/hub/environments/${p(envId)}`, undefined, body),
  deleteEnvironment: (envId: number): Command<Data<unknown>> =>
    cmd('DELETE', `/hub/environments/${p(envId)}`),
  environmentStatus: (envId: number): Command<Data<HubEnvStatus>> =>
    cmd('GET', `/hub/environments/${p(envId)}/status`),
  environmentDeploys: (envId: number, limit?: number): Command<Data<HubDeploy[]>> =>
    cmd('GET', `/hub/environments/${p(envId)}/deploys`, limit ? { limit } : undefined),
  promotable: (envId: number): Command<Data<unknown>> =>
    cmd('GET', `/hub/environments/${p(envId)}/promotable`),
  creation: (envId: number): Command<Data<HubRun>> =>
    cmd('GET', `/hub/environments/${p(envId)}/creation`),
  // Promotions
  planPromotion: (
    envId: number,
    body: { kind: 'promote' | 'rollback'; version?: string }
  ): Command<Data<HubPlan>> =>
    cmd('POST', `/hub/environments/${p(envId)}/promote/plan`, undefined, body),
  startPromotion: (
    envId: number,
    body: { kind: 'promote' | 'rollback'; version?: string; plan_hash: string; confirm: string }
  ): Command<Data<{ deploy_id: number; job_run_id: number }>> =>
    cmd('POST', `/hub/environments/${p(envId)}/promote`, undefined, body),
  listPromotions: (envId: number, limit?: number): Command<Data<HubRun[]>> =>
    cmd('GET', `/hub/environments/${p(envId)}/deploys/hub`, limit ? { limit } : undefined),
  readPromotion: (id: number): Command<Data<HubRun>> => cmd('GET', `/hub/promotions/${p(id)}`),
  cancelPromotion: (id: number): Command<Data<{ id: number; status?: string }>> =>
    cmd('POST', `/hub/promotions/${p(id)}/cancel`),
  // Moves
  planMove: (envId: number, to: Record<string, unknown>): Command<Data<HubPlan>> =>
    cmd('POST', `/hub/environments/${p(envId)}/move/plan`, undefined, { to }),
  startMove: (
    envId: number,
    body: {
      to: Record<string, unknown>
      plan_hash: string
      confirm: string
      checklist?: Record<string, boolean>
      overrides?: string[]
    }
  ): Command<Data<HubRun>> => cmd('POST', `/hub/environments/${p(envId)}/move`, undefined, body),
  listMoves: (envId: number): Command<Data<HubRun[]>> =>
    cmd('GET', `/hub/environments/${p(envId)}/moves`),
  readMove: (id: number): Command<Data<HubRun>> => cmd('GET', `/hub/moves/${p(id)}`),
  cancelMove: (id: number): Command<Data<HubRun>> => cmd('POST', `/hub/moves/${p(id)}/cancel`),
  resumeMove: (id: number): Command<Data<HubRun>> => cmd('POST', `/hub/moves/${p(id)}/resume`),
  confirmMoveRoute: (id: number): Command<Data<HubRun>> =>
    cmd('POST', `/hub/moves/${p(id)}/confirm-route`),
  finishMoveStopSource: (id: number): Command<Data<HubRun>> =>
    cmd('POST', `/hub/moves/${p(id)}/finish-stop-source`),
  tickMoveChecklist: (id: number, body: Record<string, unknown>): Command<Data<HubRun>> =>
    cmd('POST', `/hub/moves/${p(id)}/checklist`, undefined, body),
  // Shared deployments and upgrades
  listShared: (): Command<Data<HubShared[]>> => cmd('GET', '/hub/shared'),
  readShared: (id: number): Command<Data<{ row: HubShared; [key: string]: unknown }>> =>
    cmd('GET', `/hub/shared/${p(id)}`),
  createShared: (body: Record<string, unknown>): Command<Data<unknown>> =>
    cmd('POST', '/hub/shared', undefined, body),
  updateShared: (id: number, body: Record<string, unknown>): Command<Data<unknown>> =>
    cmd('PATCH', `/hub/shared/${p(id)}`, undefined, body),
  rotateSharedToken: (id: number): Command<Data<unknown>> =>
    cmd('POST', `/hub/shared/${p(id)}/token`),
  deleteShared: (id: number): Command<Data<unknown>> => cmd('DELETE', `/hub/shared/${p(id)}`),
  sharedStatus: (id: number): Command<Data<unknown>> => cmd('GET', `/hub/shared/${p(id)}/status`),
  sharedVersions: (id: number): Command<Data<unknown>> =>
    cmd('GET', `/hub/shared/${p(id)}/upgrade/versions`),
  planSharedUpgrade: (
    id: number,
    body: { kind: 'upgrade' | 'rollback'; version: string }
  ): Command<Data<HubPlan>> => cmd('POST', `/hub/shared/${p(id)}/upgrade/plan`, undefined, body),
  startSharedUpgrade: (id: number, body: Record<string, unknown>): Command<Data<HubRun>> =>
    cmd('POST', `/hub/shared/${p(id)}/upgrade`, undefined, body),
  listSharedUpgrades: (id: number): Command<Data<HubRun[]>> =>
    cmd('GET', `/hub/shared/${p(id)}/deploys`),
  readSharedUpgrade: (id: number): Command<Data<HubRun>> =>
    cmd('GET', `/hub/shared-deploys/${p(id)}`),
  cancelSharedUpgrade: (id: number): Command<Data<HubRun>> =>
    cmd('POST', `/hub/shared-deploys/${p(id)}/cancel`),
  // Databases
  listDatabases: (): Command<Data<Array<Record<string, unknown>>>> => cmd('GET', '/hub/databases'),
  readDatabase: (id: number): Command<Data<Record<string, unknown>>> =>
    cmd('GET', `/hub/databases/${p(id)}`),
  checkDatabase: (id: number): Command<Data<Record<string, unknown>>> =>
    cmd('POST', `/hub/databases/${p(id)}/check`),
  listDatabaseServers: (): Command<Data<Array<Record<string, unknown>>>> =>
    cmd('GET', '/hub/db-servers'),
  // Drivers and targets
  listDrivers: (): Command<Data<HubDriver[]>> => cmd('GET', '/hub/drivers'),
  createDriver: (body: Record<string, unknown>): Command<Data<HubDriver>> =>
    cmd('POST', '/hub/drivers', undefined, body),
  updateDriver: (id: number, body: Record<string, unknown>): Command<Data<HubDriver>> =>
    cmd('PATCH', `/hub/drivers/${p(id)}`, undefined, body),
  deleteDriver: (id: number): Command<Data<unknown>> => cmd('DELETE', `/hub/drivers/${p(id)}`),
  driverAgent: (id: number): Command<Data<unknown>> => cmd('GET', `/hub/drivers/${p(id)}/agent`),
  listTargets: (): Command<Data<Array<Record<string, unknown>>>> => cmd('GET', '/hub/targets'),
  // Creating apps
  planAppCreation: (input: Record<string, unknown>): Command<Data<HubPlan>> =>
    cmd('POST', '/hub/apps/create/plan', undefined, input)
}

type Commands = typeof hubCommands
/** `nivaro.hub.*`: every hubCommands builder, sent and unwrapped (`data`). */
export type HubClient = {
  [K in keyof Commands]: (
    ...args: Parameters<Commands[K]>
  ) => Promise<ReturnType<Commands[K]> extends Command<Data<infer T>> ? T : never>
} & {
  /** Whether the server is a Nivaro Hub (asked once per client, from GET /api/app-info). */
  isHub(): Promise<boolean>
}

interface Requester {
  request<T>(command: Command<T>): Promise<T>
}

/** The error every Hub call raises on a server that is not a Hub. */
export function hubModeOffError(method = 'GET', path = '/hub'): NivaroError {
  return new NivaroError({
    message:
      'This Nivaro is not a Hub: hub mode is off (HUB=on), so it has no /api/hub routes. nivaro.hub.* works only against a Nivaro Hub.',
    status: 404,
    code: 'HUB_MODE_OFF',
    method,
    path
  })
}

/** Builds `nivaro.hub` over a client's `request`. */
export function createHubClient(client: Requester): HubClient {
  let known: Promise<boolean> | null = null
  const isHub = (): Promise<boolean> => {
    known ??= client
      .request<{ features?: unknown }>(cmd('GET', '/app-info'))
      .then((info) => Array.isArray(info?.features) && info.features.includes('hub'))
      .catch((err) => {
        // Not answered (offline, an old server): ask again next time, let the call itself try.
        known = null
        throw err
      })
    return known
  }
  const out: Record<string, unknown> = { isHub }
  for (const [name, build] of Object.entries(hubCommands)) {
    out[name] = async (...args: unknown[]) => {
      const command = (build as (...a: unknown[]) => Command<Data<unknown>>)(...args)
      let hub: boolean | null = null
      try {
        hub = await isHub()
      } catch {
        hub = null
      }
      if (hub === false) throw hubModeOffError(command._method, command._path)
      const res = await client.request(command)
      return res && typeof res === 'object' && 'data' in res ? res.data : res
    }
  }
  return out as HubClient
}
