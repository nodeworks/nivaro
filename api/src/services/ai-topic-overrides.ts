import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { cosineSim } from './embeddings.js'

/**
 * What admins decided about Ask AI topics (Rob 2026-11-18: "the AI topic map
 * … should be actionable"): mark a topic handled or ignored, rename it, merge
 * one topic into another. Topics are rebuilt from fresh clustering every time,
 * so their ids drift; a decision therefore remembers the topic by its
 * questions (request ids) and its centre (the embedding centroid) and is
 * re-attached to whichever new topic shares most of those questions, or —
 * when none does — sits closest in meaning under the same embedding provider.
 *
 * Stored as one JSON list in nivaro_extension_settings ('nivaro-core',
 * 'ai_topic_overrides') — no table of its own. Capped at 300 decisions.
 */

export const OVERRIDES_EXT = 'nivaro-core'
export const OVERRIDES_KEY = 'ai_topic_overrides'
const MAX = 300

export type TopicStatus = 'handled' | 'ignored'

export interface TopicFingerprint {
  /** Request ids of the topic's questions when the decision was made (≤ 400). */
  members: string[]
  /** Rounded centroid. */
  centroid: number[]
  /** Embedding provider tag the centroid came from. */
  provider: string
  /** The topic's name then (what the admin saw). */
  name: string
}

export interface TopicOverride {
  id: string
  kind: 'status' | 'rename' | 'merge'
  topic: TopicFingerprint
  status?: TopicStatus
  note?: string | null
  name?: string
  /** merge: the topic this one joins. */
  into?: TopicFingerprint
  by: string
  by_name: string
  at: string
}

/** Pure: how strongly a stored fingerprint names a topic now (0 = not at all). */
export function fingerprintScore(
  fp: TopicFingerprint,
  topic: { members: string[]; centroid: number[]; provider: string }
): number {
  if (fp.members.length && topic.members.length) {
    const stored = new Set(fp.members)
    const shared = topic.members.filter((m) => stored.has(m)).length
    const overlap = shared / Math.min(stored.size, topic.members.length)
    if (shared > 0 && overlap >= 0.4) return 1 + overlap
  }
  if (
    fp.provider === topic.provider &&
    fp.centroid.length &&
    fp.centroid.length === topic.centroid.length
  ) {
    const sim = cosineSim(fp.centroid, topic.centroid)
    if (sim >= 0.86) return sim
  }
  return 0
}

/** Pure: the index of the topic a fingerprint belongs to now, or -1. */
export function matchFingerprint(
  fp: TopicFingerprint,
  topics: Array<{ members: string[]; centroid: number[]; provider: string }>
): number {
  let best = -1
  let bestScore = 0
  for (let i = 0; i < topics.length; i++) {
    const s = fingerprintScore(fp, topics[i])
    if (s > bestScore) {
      best = i
      bestScore = s
    }
  }
  return best
}

export function fingerprintOf(
  members: string[],
  centroid: number[],
  provider: string,
  name: string
): TopicFingerprint {
  return {
    members: members.slice(0, 400),
    centroid: centroid.map((x) => Math.round(x * 10_000) / 10_000),
    provider,
    name: name.slice(0, 80)
  }
}

export async function loadOverrides(): Promise<TopicOverride[]> {
  const row = (await db('nivaro_extension_settings')
    .where({ extension_id: OVERRIDES_EXT, key: OVERRIDES_KEY })
    .first('value')
    .catch(() => undefined)) as { value: string | null } | undefined
  try {
    const v = JSON.parse(row?.value ?? '[]')
    return Array.isArray(v) ? (v as TopicOverride[]) : []
  } catch {
    return []
  }
}

async function saveOverrides(list: TopicOverride[], by: string): Promise<void> {
  const value = JSON.stringify(list.slice(-MAX))
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: OVERRIDES_EXT, key: OVERRIDES_KEY })
    .first('id')) as { id: number } | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date(), updated_by: by })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: OVERRIDES_EXT,
      key: OVERRIDES_KEY,
      value,
      updated_at: new Date(),
      updated_by: by
    })
}

/**
 * Add a decision. A new status or name for the same topic replaces the old one
 * (one status and one name per topic); merges stack.
 */
export async function addOverride(o: Omit<TopicOverride, 'id' | 'at'>): Promise<TopicOverride> {
  const list = await loadOverrides()
  const next: TopicOverride = { ...o, id: randomUUID().slice(0, 12), at: new Date().toISOString() }
  const kept =
    o.kind === 'merge'
      ? list
      : list.filter(
          (x) =>
            x.kind !== o.kind ||
            fingerprintScore(x.topic, {
              members: o.topic.members,
              centroid: o.topic.centroid,
              provider: o.topic.provider
            }) === 0
        )
  const out = o.kind === 'status' && !o.status ? kept : [...kept, next]
  await saveOverrides(out, o.by)
  return next
}

export async function removeOverride(id: string, by: string): Promise<boolean> {
  const list = await loadOverrides()
  const next = list.filter((x) => x.id !== id)
  if (next.length === list.length) return false
  await saveOverrides(next, by)
  return true
}
