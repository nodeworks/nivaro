import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { isMultiTenant } from '../deployment-mode.js'
import { instanceKey } from '../instance-key.js'
import { bustInstanceOverridesCache } from '../settings-overrides.js'

/**
 * The master switch for GitLab sync. OFF by default, per instance. Order of precedence:
 * cloud mode (always off) > env ISSUE_TRACKERS on|off > the stored setting (key `issue_trackers`
 * on this instance's nivaro_settings_overrides row) > default off.
 */
export type FeatureSource = 'env' | 'setting' | 'default' | 'cloud'
export interface FeatureState {
  enabled: boolean
  source: FeatureSource
}

export const FEATURE_KEY = 'issue_trackers'
const TTL_MS = 5000

let cache: { at: number; value: FeatureState } | null = null

export function bustTrackersFeatureCache(): void {
  cache = null
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
  if (isMultiTenant()) return { enabled: false, source: 'cloud' }
  const env = envValue()
  if (env !== null) return { enabled: env, source: 'env' }
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
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  const value = await compute()
  cache = { at: Date.now(), value }
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
