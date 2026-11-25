import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { appBox } from '../app-state.js'
import { isNivaroCloud, perAppJobs } from '../deployment-mode.js'
import { instanceKey } from '../instance-key.js'
import { bustInstanceOverridesCache } from '../settings-overrides.js'

/**
 * The master switch for GitLab sync. OFF by default, per instance. Order of precedence:
 * Nivaro Cloud (always off) > env ISSUE_TRACKERS on|off > the stored setting (key
 * `issue_trackers` on this instance's nivaro_settings_overrides row) > default off.
 *
 * On a Hub shared deployment (one process, many apps) the switch is per app: the stored setting
 * lives in each app's own database. The process env belongs to the whole deployment there, so
 * ISSUE_TRACKERS=off turns sync off for every app on it (and locks the switch), while
 * ISSUE_TRACKERS=on does not switch any app on: each app's own stored switch decides (the same
 * rule as TEAMS_BOT).
 */
export type FeatureSource = 'env' | 'setting' | 'default' | 'cloud'
export interface FeatureState {
  enabled: boolean
  source: FeatureSource
}

export const FEATURE_KEY = 'issue_trackers'
const TTL_MS = 5000

// One cache per app (a Hub shared deployment serves many apps from this process, each with its
// own switch). A bust inside an app clears that app's; outside one, every app's.
const cache = appBox<{ at: number; value: FeatureState } | null>(() => null)

export function bustTrackersFeatureCache(): void {
  cache.reset()
}

function envValue(): boolean | null {
  const v = (process.env.ISSUE_TRACKERS ?? '').trim().toLowerCase()
  if (v === 'on' || v === 'true' || v === '1') return true
  if (v === 'off' || v === 'false' || v === '0') return false
  return null
}

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: unknown } | undefined
  if (!row) return null
  try {
    const raw = row.data
    const parsed = typeof raw === 'string' ? (raw ? JSON.parse(raw) : {}) : (raw ?? {})
    return {
      id: row.id,
      data: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    }
  } catch {
    return { id: row.id, data: {} }
  }
}

async function compute(): Promise<FeatureState> {
  if (isNivaroCloud()) return { enabled: false, source: 'cloud' }
  const env = envValue()
  // A shared deployment's env `on` is not any app's choice: only `off` applies there.
  if (env !== null && !(env && perAppJobs())) return { enabled: env, source: 'env' }
  try {
    const stored = (await readRow())?.data[FEATURE_KEY] as { enabled?: unknown } | undefined
    if (stored && typeof stored.enabled === 'boolean')
      return { enabled: stored.enabled, source: 'setting' }
  } catch {
    // table missing / unreadable: the default
  }
  return { enabled: false, source: 'default' }
}

export async function trackersFeature(): Promise<FeatureState> {
  const hit = cache.value
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await compute()
  cache.value = { at: Date.now(), value }
  return value
}

export async function trackersEnabled(): Promise<boolean> {
  return (await trackersFeature()).enabled
}

export class FeatureLockedError extends Error {
  code = 'FEATURE_LOCKED'
  constructor(source: FeatureSource) {
    super(
      source === 'cloud'
        ? 'GitLab sync is not available in cloud mode'
        : 'Set by the ISSUE_TRACKERS setting on the server'
    )
  }
}

export async function setTrackersEnabled(enabled: boolean, userId: string): Promise<FeatureState> {
  bustTrackersFeatureCache()
  const current = await compute()
  if (current.source === 'env' || current.source === 'cloud')
    throw new FeatureLockedError(current.source)

  const row = await readRow()
  const data = { ...(row?.data ?? {}), [FEATURE_KEY]: { enabled } }
  let id = row?.id
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    const inserted = (await db('nivaro_settings_overrides')
      .insert({ instance_key: instanceKey(), data: JSON.stringify(data), updated_at: new Date() })
      .returning('id')) as unknown[]
    const first = inserted[0]
    id = Number(typeof first === 'object' && first !== null ? (first as { id: unknown }).id : first)
  }
  bustTrackersFeatureCache()
  bustInstanceOverridesCache()
  await logActivity({
    action: 'update',
    user: userId,
    collection: 'nivaro_settings_overrides',
    item: id != null && !Number.isNaN(id) ? String(id) : undefined,
    comment: enabled ? 'GitLab sync turned on' : 'GitLab sync turned off'
  })
  return { enabled, source: 'setting' }
}

/** preHandler for the admin plugin: everything but `/trackers/feature` answers 404 when off. */
export async function requireFeatureOn(req: FastifyRequest, reply: FastifyReply) {
  const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '')
  if (path.endsWith('/trackers/feature')) return
  if (await trackersEnabled()) return
  return reply.code(404).send({ error: 'GitLab sync is turned off', code: 'FEATURE_OFF' })
}
