import { db } from '../../../db/index.js'
import { type EnvOrder, flagOf, isProductionEnv } from '../owner-access.js'
import type { PersonIdentity } from './directory.js'
import {
  callPeople,
  type PeopleAccount,
  type PeopleCallDeps,
  type PeopleOp,
  type PeopleTarget,
  peopleTargetOf
} from './link-calls.js'

/**
 * The live half of the Hub people directory: every environment the Hub runs is asked, over its
 * hub link (dedicated) or its shared deployment's link (shared), which accounts match a person —
 * by email or Entra object id only — and with which role. At most PEOPLE_CONCURRENCY calls at a
 * time, each bounded (link-calls.ts). Archived environments are never asked.
 */

export const PEOPLE_CONCURRENCY = 6

export interface HubEnvRef {
  id: number
  app_id: number
  app_key: string
  app_name: string
  key: string
  position: number
  status: string
  base_url: string
  hub_token: string | null
  placement_id: number | null
  production: boolean
}

export interface EnvAccess {
  environment_id: number
  app_id: number
  app_key: string
  app_name: string
  environment_key: string
  production: boolean
  state: 'account' | 'none' | 'no_link' | 'error'
  code?: string
  accounts: PeopleAccount[]
}

/** Every environment the Hub may ask (not archived), apps by name, environments in order. */
export async function askableEnvironments(): Promise<HubEnvRef[]> {
  const rows = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .whereNot('e.status', 'archived')
    .select(
      'e.id',
      'e.app_id',
      'a.key as app_key',
      'a.name as app_name',
      'e.key',
      'e.position',
      'e.status',
      'e.base_url',
      'e.hub_token',
      'e.placement_id',
      'e.production'
    )) as Array<Record<string, unknown>>
  const byApp = new Map<number, EnvOrder[]>()
  for (const r of rows) {
    const list = byApp.get(Number(r.app_id)) ?? []
    list.push({
      id: Number(r.id),
      key: String(r.key),
      position: Number(r.position ?? 0),
      status: String(r.status),
      production: flagOf(r.production)
    })
    byApp.set(Number(r.app_id), list)
  }
  return rows
    .map((r) => {
      const env = {
        id: Number(r.id),
        key: String(r.key),
        position: Number(r.position ?? 0),
        status: String(r.status),
        production: flagOf(r.production)
      }
      return {
        id: env.id,
        app_id: Number(r.app_id),
        app_key: String(r.app_key),
        app_name: String(r.app_name),
        key: env.key,
        position: env.position,
        status: String(r.status),
        base_url: String(r.base_url),
        hub_token: (r.hub_token as string | null) ?? null,
        placement_id: r.placement_id == null ? null : Number(r.placement_id),
        production: isProductionEnv(env, byApp.get(Number(r.app_id)) ?? [])
      }
    })
    .sort((a, b) => a.app_name.localeCompare(b.app_name) || a.position - b.position || a.id - b.id)
}

/** Runs `fn` over `items`, at most `width` at a time, answers in the items' order. */
export async function inPool<T, R>(
  items: T[],
  width: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  return out
}

export interface AccessDeps extends PeopleCallDeps {
  environments?: () => Promise<HubEnvRef[]>
  targetOf?: (env: HubEnvRef) => Promise<PeopleTarget | null>
  call?: typeof callPeople
}

/** One environment: its target, then the call. Never throws. */
export async function askEnvironment(
  env: HubEnvRef,
  op: PeopleOp,
  identity: PersonIdentity,
  deps: AccessDeps = {}
) {
  try {
    const target = await (deps.targetOf ?? peopleTargetOf)(env)
    if (!target) return { target: null, result: null }
    const result = await (deps.call ?? callPeople)(target, op, identity, deps)
    return { target, result }
  } catch {
    return {
      target: undefined,
      result: { ok: false as const, code: 'LINK_UNREACHABLE', status: 0 }
    }
  }
}

/** Which accounts the person holds in every environment, and their role there. */
export async function personAccess(
  identity: PersonIdentity,
  deps: AccessDeps = {}
): Promise<EnvAccess[]> {
  const envs = await (deps.environments ?? askableEnvironments)()
  return inPool(envs, PEOPLE_CONCURRENCY, async (env): Promise<EnvAccess> => {
    const base = {
      environment_id: env.id,
      app_id: env.app_id,
      app_key: env.app_key,
      app_name: env.app_name,
      environment_key: env.key,
      production: env.production,
      accounts: [] as PeopleAccount[]
    }
    const { target, result } = await askEnvironment(env, 'lookup', identity, deps)
    if (target === null) return { ...base, state: 'no_link' }
    if (!result || !result.ok)
      return { ...base, state: 'error', code: result?.code ?? 'LINK_UNREACHABLE' }
    return {
      ...base,
      state: result.accounts.length ? 'account' : 'none',
      accounts: result.accounts
    }
  })
}
