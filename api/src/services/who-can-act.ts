import { db } from '../db/index.js'
import type { User } from '../types.js'
import { listPhrase } from './access-words.js'
import { explainRecordOwners } from './owner-explain.js'
import { UNAVAILABLE_TEXT, type Unavailability } from './record-access.js'

/**
 * #1907 — "who can approve this right now?"
 *
 * The current step's owners AFTER out-of-office delegation, owner groups and
 * teams are applied (explainRecordOwners → resolveStateOwnersBatch), each
 * marked available or not (suspended, redacted, out with no working
 * delegate) and online or not. Online is the presence list's own rule
 * (a heartbeat in the last 70 s) and is only reported for people the ASKER
 * may see on the online list — someone outside the asker's visibility reads
 * as "not shown", never as offline.
 */

export interface ActNowPerson {
  id: string
  name: string
  available: boolean
  unavailable_reason: string | null
  online: boolean | null
  stands_in_for: string[]
  /** Listed by the record's fallback field only: it sits in their queue,
   *  but they cannot approve the step (owner-only moves skip the fallback). */
  queue_only?: boolean
}

export interface ActNowAnswer {
  record: string
  state: string
  people: ActNowPerson[]
  summary: string
}

const ONLINE_WINDOW_MS = 70_000

async function onlineSet(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  try {
    const rows = (await db('user_presence')
      .whereIn('user_id', ids)
      .where('last_seen', '>=', new Date(Date.now() - ONLINE_WINDOW_MS))
      .where((q) => void q.where('is_online', true).orWhereNull('is_online'))
      .select('user_id')) as Array<{ user_id: string }>
    return new Set(rows.map((r) => String(r.user_id).toUpperCase()))
  } catch {
    return new Set()
  }
}

export function actNowSummary(state: string, people: ActNowPerson[]): string {
  if (people.length === 0) return `Nobody owns ${state} for this record right now.`
  const queueOnly = people.filter((p) => p.queue_only)
  const queueText =
    queueOnly.length > 0
      ? ` ${listPhrase(queueOnly.map((p) => p.name))} ${queueOnly.length === 1 ? 'has' : 'have'} it in their queue but cannot approve it.`
      : ''
  const owners = people.filter((p) => !p.queue_only)
  if (owners.length === 0)
    return `Nobody can approve ${state} right now — no owner is assigned to it.${queueText}`
  const able = owners.filter((p) => p.available)
  const online = able.filter((p) => p.online === true)
  if (able.length === 0)
    return `Nobody can act on ${state} right now — every owner is unavailable (${listPhrase(
      owners.map((p) => `${p.name}: ${p.unavailable_reason ?? 'unavailable'}`)
    )}).${queueText}`
  const who = listPhrase(
    able.map((p) =>
      p.stands_in_for.length ? `${p.name} (standing in for ${listPhrase(p.stands_in_for)})` : p.name
    )
  )
  const onlineText =
    online.length > 0
      ? ` ${listPhrase(online.map((p) => p.name))} ${online.length === 1 ? 'is' : 'are'} online now.`
      : able.some((p) => p.online === false)
        ? ' None of them is online right now.'
        : ''
  return `${who} can act on ${state} now.${onlineText}${queueText}`
}

export async function whoCanActNow(
  viewer: User,
  viewerIsAdmin: boolean,
  collection: string,
  item: string
): Promise<ActNowAnswer | null> {
  const ex = await explainRecordOwners(collection, item)
  if (!ex) return null
  const ids = ex.owners.map((o) => o.id)
  const { visibleToViewer } = await import('../routes/presence.js')
  const [online, visible] = await Promise.all([
    onlineSet(ids),
    visibleToViewer(viewer, viewerIsAdmin, ids).catch(() => new Set<string>())
  ])
  const people: ActNowPerson[] = ex.owners.map((o) => {
    const k = String(o.id).toUpperCase()
    const covers = o.sources.filter((s) => s.kind === 'delegate').map((s) => s.for_name ?? '')
    return {
      id: o.id,
      name: o.name,
      available: !o.unavailable,
      unavailable_reason: o.unavailable
        ? UNAVAILABLE_TEXT[o.unavailable as Unavailability].replace(/\.$/, '').toLowerCase()
        : null,
      online: visible.has(k) ? online.has(k) : null,
      stands_in_for: covers.filter(Boolean),
      ...(o.queue_only ? { queue_only: true } : {})
    }
  })
  return {
    record: `${collection}/${item}`,
    state: ex.state.label,
    people,
    summary: actNowSummary(ex.state.label, people)
  }
}
