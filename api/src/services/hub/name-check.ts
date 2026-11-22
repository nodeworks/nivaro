// The environment name check (phase 3 owns it, cross-phase ruling `waiting_for_name`): an
// environment whose name is made by hand waits in status `waiting_for_name` until its hostname
// resolves AND `<base_url>/api/version` answers the expected version. There is no timeout.
//
// checkName(envId) looks once and answers 'ok' | 'waiting'. For an environment no creation is
// walking (e.g. phase 4: a Docker deploy finished with a manual name not yet working, status set
// through markWaitingForName), 'ok' also moves `waiting_for_name` → `active`. While a creation
// leg is open (queued / running / waiting) the status is left alone: the creation runner (Task 9)
// moves the environment on, with its own link and first-admin steps after the name.
//
// Expected version: the open creation's version, else the environment's version_pin, else any
// version that answers.
import { db } from '../../db/index.js'
import { parseJson } from '../pipeline-engine.js'
import { checkName as checkHostname, type NameCheck } from './create/name-check.js'

export type NameCheckDeps = Parameters<typeof checkHostname>[3]

export const WAITING_FOR_NAME = 'waiting_for_name'

const OPEN_CREATION = ['queued', 'running', 'waiting']

function firstHostname(hostnames: unknown, baseUrl: string): string | null {
  const list = typeof hostnames === 'string' ? parseJson(hostnames) : hostnames
  if (Array.isArray(list)) {
    const h = list.find((x): x is string => typeof x === 'string' && !!x.trim())
    if (h) return h.trim().toLowerCase()
  }
  try {
    return new URL(baseUrl).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/** One look at an environment's name, with the reason; null when the environment is unknown. */
export async function checkEnvironmentName(
  envId: number,
  deps?: NameCheckDeps
): Promise<{ result: 'ok' | 'waiting'; hostname: string | null; check: NameCheck } | null> {
  if (!Number.isInteger(envId)) return null
  const env = (await db('nivaro_hub_environments')
    .where({ id: envId })
    .first('id', 'status', 'base_url', 'hostnames', 'version_pin')) as
    | {
        id: number
        status: string
        base_url: string
        hostnames: unknown
        version_pin: string | null
      }
    | undefined
  if (!env) return null

  const creation = (await db('nivaro_hub_creations')
    .where({ environment_id: envId })
    .first('status', 'version')) as { status: string; version: string } | undefined
  const open = !!creation && OPEN_CREATION.includes(String(creation.status))
  const version = (open ? creation?.version : null) ?? env.version_pin ?? ''

  const hostname = firstHostname(env.hostnames, String(env.base_url ?? ''))
  const check = await checkHostname(
    hostname ?? '',
    String(env.base_url ?? ''),
    String(version),
    deps
  )
  const result = check.resolves && check.serves ? 'ok' : 'waiting'

  if (result === 'ok' && env.status === WAITING_FOR_NAME && !open) {
    // The open-creation test rides the UPDATE itself: a creation opened since the read above
    // keeps the status (its runner moves the environment on).
    await db('nivaro_hub_environments')
      .where({ id: envId, status: WAITING_FOR_NAME })
      .whereNotExists(
        db('nivaro_hub_creations')
          .where('environment_id', envId)
          .whereIn('status', OPEN_CREATION)
          .select('id')
      )
      .update({ status: 'active', updated_at: new Date() })
  }
  return { result, hostname, check }
}

/** 'ok' once the name resolves and serves the expected version, else 'waiting'. */
export async function checkName(envId: number, deps?: NameCheckDeps): Promise<'ok' | 'waiting'> {
  return (await checkEnvironmentName(envId, deps))?.result ?? 'waiting'
}

/** The statuses markWaitingForName may move an environment from. */
export const MAY_WAIT_FOR_NAME: readonly string[] = Object.freeze([
  'active',
  'provisioning',
  WAITING_FOR_NAME
])

/**
 * Puts an environment in `waiting_for_name` (phase 4's deploy with a manual name not yet
 * working). Only from MAY_WAIT_FOR_NAME: any other status (one another flow set) stays.
 */
export async function markWaitingForName(envId: number): Promise<void> {
  if (!Number.isInteger(envId)) return
  await db('nivaro_hub_environments')
    .where({ id: envId })
    .whereIn('status', MAY_WAIT_FOR_NAME)
    .update({ status: WAITING_FOR_NAME, updated_at: new Date() })
}
