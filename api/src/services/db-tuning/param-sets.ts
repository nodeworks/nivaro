import { createHash } from 'node:crypto'
import { db } from '../../db/index.js'
import { hasColumn } from '../../lib/column-probe.js'
import { isSensitiveKey, MASK } from '../secret-mask.js'

const KEEP = 10

/** Only what a call actually bound: undefined, null and '' fall back to the default. */
export function effectiveParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out
}

export function maskParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) out[k] = isSensitiveKey(k) ? MASK : v
  return out
}

/** Keys sorted, masked values hashed as their mask — the stored row and the live call agree. */
export function paramSetHash(params: Record<string, unknown>): string {
  const masked = maskParams(params)
  const keys = Object.keys(masked).sort()
  return createHash('sha1')
    .update(JSON.stringify(keys.map((k) => [k, masked[k] ?? null])))
    .digest('hex')
    .slice(0, 40)
}

async function tablePresent(): Promise<boolean> {
  return hasColumn('nivaro_tuning_param_sets', 'hash').catch(() => false)
}

/** Fire-and-forget: a failed insert never reaches the caller. */
export async function recordParamSet(
  kind: 'query' | 'proc',
  target: string,
  params: Record<string, unknown>
): Promise<void> {
  try {
    if (!(await tablePresent())) return
    params = effectiveParams(params)
    const hash = paramSetHash(params)
    const t = target.slice(0, 300)
    const updated = await db('nivaro_tuning_param_sets')
      .where({ target_kind: kind, target: t, hash })
      .update({ seen_count: db.raw('seen_count + 1'), last_seen: new Date() })
    if (!updated) {
      await db('nivaro_tuning_param_sets').insert({
        target_kind: kind,
        target: t,
        params: JSON.stringify(maskParams(params)),
        hash,
        seen_count: 1,
        last_seen: new Date()
      })
      const rows = (await db('nivaro_tuning_param_sets')
        .where({ target_kind: kind, target: t })
        .orderBy('last_seen', 'desc')
        .select('id')) as Array<{ id: number }>
      const stale = rows.slice(KEEP).map((r) => r.id)
      if (stale.length) await db('nivaro_tuning_param_sets').whereIn('id', stale).del()
    }
  } catch {
    /* evidence only */
  }
}

export async function paramSetsFor(
  kind: 'query' | 'proc',
  target: string
): Promise<Array<Record<string, unknown>>> {
  if (!(await tablePresent())) return []
  const rows = (await db('nivaro_tuning_param_sets')
    .where({ target_kind: kind, target })
    .orderBy('last_seen', 'desc')
    .limit(KEEP)
    .select('params')) as Array<{ params: string }>
  const out: Array<Record<string, unknown>> = []
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.params))
    } catch {
      /* skip */
    }
  }
  return out
}
