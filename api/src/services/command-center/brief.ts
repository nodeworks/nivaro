import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { User } from '../../types.js'
import { tenantState } from '../ai-tenant-state.js'
import { type FeedRow, readFeed } from './activity.js'
import { readBanner } from './banner.js'
import { type PartnerHealthRow, readPartners } from './partners.js'
import type { CcScope } from './scope.js'
import { readSystemHealth, type SystemHealthAnswer } from './system.js'
import { readThroughput, type ThroughputAnswer, zonedParts } from './throughput.js'

/**
 * "What changed?" (CC-18): a short plain-language summary of the last hour, built ONLY from the
 * figures the caller's own panels show — the same services, read as the caller: throughput
 * (collections they may read), the feed (records they can see; counted per collection, never a
 * record's name or values), and for administrators partners, system and incident state.
 *
 * The facts are written as plain sentences first (`briefFacts`, pure). With AI available and
 * allowed (the same rule as the AI briefing: AI feature `brief` not disabled, per-person caps,
 * the one AI client factory) a model rewrites them as a short paragraph and is told to add
 * nothing; without AI the facts themselves are the brief. Either way the model never sees a
 * row — only the facts.
 *
 * Cached per person + region + rewind hour for 5 minutes; Refresh (`fresh`) rebuilds.
 */

export interface BriefInput {
  throughput: Pick<ThroughputAnswer, 'hours' | 'today_total' | 'yesterday_same_time'> | null
  /** The readable feed of the last hour (already filtered as the caller). */
  feed: FeedRow[]
  partners: PartnerHealthRow[]
  system: SystemHealthAnswer | null
  maintenance: boolean
  incident: string | null
  drill?: boolean
  /** Hour (0–23, the person's zone) the brief is about. */
  hour: number
  rewound: boolean
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The brief as plain sentences, from figures only (pure — the test seam). */
export function briefFacts(i: BriefInput): string[] {
  const out: string[] = []
  if (i.maintenance) out.push('Maintenance mode is on: saving changes is paused.')
  if (i.incident) out.push(`An incident is open: ${i.incident}.`)

  const t = i.throughput
  if (t) {
    const now = t.hours[i.hour]
    const thisHour = now?.today ?? 0
    const usual = now?.avg7 ?? 0
    const vs =
      usual > 0
        ? thisHour >= usual * 1.5
          ? ', busier than usual for this hour'
          : thisHour <= usual * 0.5
            ? ', quieter than usual for this hour'
            : ', about usual for this hour'
        : ''
    out.push(`${plural(thisHour, 'transition')} so far this hour${vs}.`)
    const d = t.today_total - t.yesterday_same_time
    out.push(
      `${plural(t.today_total, 'transition')} today, ${d === 0 ? 'the same as' : `${Math.abs(d)} ${d > 0 ? 'more than' : 'fewer than'}`} yesterday by this time.`
    )
  }

  // Feed: counts per kind and per collection (readable names only, never a record).
  const created = i.feed.filter((e) => e.action === 'create').length
  const updated = i.feed.filter((e) => e.action === 'update').length
  const deleted = i.feed.filter((e) => e.action === 'delete').length
  const moved = i.feed.filter((e) => /transition/.test(e.action)).length
  if (i.feed.length === 0) out.push('No record changes you can see in the last hour.')
  else {
    const parts = [
      created ? `${created} created` : null,
      updated ? `${updated} updated` : null,
      deleted ? `${deleted} deleted` : null,
      moved ? `${moved} moved along a pipeline` : null
    ].filter(Boolean)
    const byCollection = new Map<string, number>()
    for (const e of i.feed) {
      const name = e.collection_label || null
      if (name) byCollection.set(name, (byCollection.get(name) ?? 0) + 1)
    }
    const top = [...byCollection]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, n]) => `${name} (${n})`)
    out.push(
      `In the last hour: ${parts.join(', ')}${top.length ? `, mostly in ${top.join(', ')}` : ''}.`
    )
  }

  const bad = i.partners.filter((p) => p.status === 'down' || p.status === 'degraded')
  if (bad.length)
    out.push(
      `${plural(bad.length, 'partner')} not healthy: ${bad
        .slice(0, 3)
        .map((p) => `${p.label} (${p.status === 'down' ? 'failing' : 'degraded'})`)
        .join(', ')}.`
    )
  if (i.system) {
    const s = i.system
    const issues = [
      !s.db_ok ? 'the database is not answering' : null,
      !s.redis_ok ? 'Redis is not answering' : null,
      s.jobs_failed_1h > 0 ? `${plural(s.jobs_failed_1h, 'background job')} failed` : null,
      s.errors_1h > 0 ? `${plural(s.errors_1h, 'server error')} in the last hour` : null
    ].filter(Boolean)
    out.push(issues.length ? `System: ${issues.join('; ')}.` : 'System: all normal.')
  }
  if (i.drill) out.push('A practice drill is running, so some failures may be deliberate.')
  if (i.rewound) out.push('(As of the rewound time.)')
  return out
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const store = tenantState(
  () => new Map<string, { at: number; text: string; generated_at: string }>()
)
const TTL_MS = 5 * 60_000

export function briefCacheKey(userId: string, scope: CcScope, now = Date.now()): string {
  const t = scope.at ? scope.at.getTime() : now
  return `${userId}|${scope.region ?? '-'}|${scope.at ? 'at' : 'live'}|${Math.floor(t / 3600_000)}`
}

// ─── Build ───────────────────────────────────────────────────────────────────

export interface BriefContext {
  app: FastifyInstance
  req: FastifyRequest
  user: User
  isAdmin: boolean
  scope: CcScope
  tz: string
  fresh?: boolean
  drill?: boolean
}

async function gather(c: BriefContext): Promise<BriefInput> {
  const cut = c.scope.at ? c.scope.at.getTime() : Date.now()
  const safe = async <T>(fn: () => Promise<T>, fallback: T) => {
    try {
      return await fn()
    } catch {
      return fallback
    }
  }
  const [throughput, feed, partners, system, banner] = await Promise.all([
    safe(() => readThroughput(c.user, c.scope, c.tz), null),
    safe(
      () =>
        readFeed(c.user, c.isAdmin, c.scope, {
          limit: 100,
          since: new Date(cut - 3600_000)
        }).then((f) => f.entries),
      [] as FeedRow[]
    ),
    c.isAdmin ? safe(() => readPartners(c.app, c.req), []) : Promise.resolve([]),
    c.isAdmin
      ? safe(
          () =>
            readSystemHealth(
              (c.app as unknown as { redis?: { ping: () => Promise<string> } }).redis
            ),
          null
        )
      : Promise.resolve(null),
    safe(() => readBanner(c.isAdmin), { maintenance: null, incident: null })
  ])
  return {
    throughput,
    feed,
    partners,
    // Live-only figures do not describe a rewound hour.
    system: c.scope.at ? null : system,
    maintenance: !c.scope.at && !!banner.maintenance,
    incident: c.scope.at ? null : (banner.incident?.title ?? null),
    drill: !c.scope.at && !!c.drill,
    hour: zonedParts(cut, c.tz).h,
    rewound: !!c.scope.at
  }
}

const SYSTEM_PROMPT = [
  'You turn a list of facts about a business operations board into a short plain-language',
  'summary of the last hour for the person looking at it. Rules: use ONLY the facts given;',
  'never invent numbers, names, causes or advice; at most four sentences; plain everyday',
  'words, no jargon, no headings, no bullet points, no markdown. Lead with anything that',
  'needs attention.'
].join(' ')

async function aiRewrite(userId: string, facts: string[]): Promise<string | null> {
  try {
    const { db } = await import('../../db/index.js')
    const row = (await db('nivaro_settings')
      .first('ai_disabled_features')
      .catch(() => null)) as { ai_disabled_features?: string | null } | null
    const disabled = row?.ai_disabled_features
      ? (JSON.parse(row.ai_disabled_features) as string[])
      : []
    if (Array.isArray(disabled) && disabled.includes('brief')) return null
    const { getAiClient, getAiModelSettings } = await import('../ai-client.js')
    const client = await getAiClient()
    if (!client) return null
    const { allowUserFeatureCall, takeUserSlot } = await import('../ai-user-limits.js')
    if (!allowUserFeatureCall('cc-brief', userId, 6)) return null
    const release = takeUserSlot('cc-brief', userId, 1)
    if (!release) return null
    try {
      const { summarizeModel } = await getAiModelSettings()
      const msg = await client.messages.create({
        model: summarizeModel,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Facts:\n- ${facts.join('\n- ')}` }]
      })
      const text = msg.content
        .filter((p) => p.type === 'text')
        .map((p) => ('text' in p ? p.text : ''))
        .join('')
        .trim()
      return text || null
    } finally {
      release()
    }
  } catch {
    // Over a cap, AI down, gateway refused: the plain facts still answer.
    return null
  }
}

export async function buildBrief(c: BriefContext): Promise<{ text: string; generated_at: string }> {
  const key = briefCacheKey(String(c.user.id), c.scope)
  const cache = store()
  const hit = cache.get(key)
  if (!c.fresh && hit && Date.now() - hit.at < TTL_MS)
    return { text: hit.text, generated_at: hit.generated_at }
  const facts = briefFacts(await gather(c))
  const text = (await aiRewrite(String(c.user.id), facts)) ?? facts.join(' ')
  const generated_at = new Date().toISOString()
  cache.set(key, { at: Date.now(), text, generated_at })
  if (cache.size > 2000)
    for (const [k, v] of cache) if (Date.now() - v.at >= TTL_MS) cache.delete(k)
  return { text, generated_at }
}
