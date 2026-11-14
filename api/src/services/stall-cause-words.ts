// api/src/services/stall-cause-words.ts
/**
 * The freeze alert's cause in plain words (services/stall-causes.ts captures it on the process
 * that stalled). Pure apart from `stallLabels`, which reads display names for the people and
 * collections the culprits name — at alert time, on the process building the alert.
 *
 * "Most likely cause: GET resolve-paths on Unit Types by Sam Rivera (Unit Types list) —
 * 63 s, on prod · web-2."
 *
 * Only what the capture kept goes into the text: method, route template, collection, person,
 * screen pattern, durations, instance, request id. No query string, body or SQL ever reaches it.
 */
import { collectionTitle } from './record-label-fallback.js'
import { LIKELY_SHARE, type StallCulprit, type StallRecord } from './stall-causes.js'

export interface StallLabels {
  /** Upper-case user id → display name. */
  users: Map<string, string>
  /** Collection key → display name. */
  collections: Map<string, string>
  /** IANA zone for clock times in the text. */
  zone: string
}

export interface CulpritView extends StallCulprit {
  /** Last literal route segment: `resolve-paths`. */
  action: string
  collection_label: string | null
  user_name: string | null
  page_label: string | null
  /** The culprit in one line ("GET resolve-paths on Unit Types by … (Unit Types list) — 63 s"). */
  sentence: string
  /** Covers most of the stall and ranked first. */
  likely: boolean
}

export interface StallCauseView {
  node: string
  role: string | null
  /** Epoch ms the stall ended. */
  at: number
  ms: number
  /** Stalls this node recorded in the window. */
  stalls: number
  culprits: CulpritView[]
}

export interface StallCauses {
  /** "Most likely cause: …" / "Possible cause: …" / "No request was running …", or null. */
  headline: string | null
  /** Worst stall per stalled node, worst first. */
  nodes: StallCauseView[]
}

const COLLECTION_PAGE_ROOTS = new Set(['collections', 'records'])

/** "1.2 s", "63 s", "2 min 5 s", "850 ms". */
export function fmtStallMs(ms: number): string {
  const v = Math.max(0, Math.round(ms))
  if (v < 1000) return `${v} ms`
  if (v < 10_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')} s`
  if (v < 90_000) return `${Math.round(v / 1000)} s`
  const m = Math.floor(v / 60_000)
  const s = Math.round((v % 60_000) / 1000)
  return s ? `${m} min ${s} s` : `${m} min`
}

/** `/api/items/:collection/resolve-paths` → `resolve-paths`; no literal → `request`. */
export function routeAction(route: string): string {
  const segs = String(route || '')
    .split('?')[0]
    .split('/')
    .filter((s) => s && !s.startsWith(':') && s !== '*' && s !== 'api')
  return segs.length ? segs[segs.length - 1].slice(0, 60) : 'request'
}

const words = (s: string) => {
  const w = s.replace(/[-_]+/g, ' ').trim()
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : ''
}

function collectionLabel(c: string, labels: StallLabels): string {
  return labels.collections.get(c) ?? collectionTitle(c)
}

/** The screen in words: "Unit Types list", "A Unit Types record", "Admin › Integrations". */
export function pageWords(page: string | null, labels: StallLabels): string | null {
  if (!page) return null
  const segs = page.split('/').filter(Boolean)
  if (segs.length === 0) return 'Home'
  const [a, b, c] = segs
  if (COLLECTION_PAGE_ROOTS.has(a) && b && !b.startsWith(':')) {
    const name = collectionLabel(b, labels)
    if (!c) return `${name} list`
    return c === 'new' ? `New ${name} record` : `${name} record`
  }
  const named = segs
    .filter((s) => !s.startsWith(':'))
    .map(words)
    .filter(Boolean)
  return named.length ? named.join(' › ') : 'Home'
}

/** Every user id and collection key the records name (for one label read). */
export function stallNames(records: StallRecord[]): { users: string[]; collections: string[] } {
  const users = new Set<string>()
  const collections = new Set<string>()
  for (const r of records)
    for (const c of r.culprits) {
      if (c.user_id) users.add(c.user_id.toUpperCase())
      if (c.collection) collections.add(c.collection)
      const segs = (c.page ?? '').split('/').filter(Boolean)
      if (COLLECTION_PAGE_ROOTS.has(segs[0]) && segs[1] && !segs[1].startsWith(':'))
        collections.add(segs[1])
    }
  return { users: [...users].slice(0, 100), collections: [...collections].slice(0, 100) }
}

export function viewCulprit(c: StallCulprit, labels: StallLabels, first: boolean): CulpritView {
  const action = routeAction(c.route)
  const collection_label = c.collection ? collectionLabel(c.collection, labels) : null
  const user_name = c.user_id
    ? (labels.users.get(c.user_id.toUpperCase()) ?? 'a signed-in person')
    : null
  const page_label = pageWords(c.page, labels)
  const sentence = [
    `${c.method} ${action}`,
    collection_label ? ` on ${collection_label}` : '',
    user_name ? ` by ${user_name}` : '',
    page_label ? ` (${page_label})` : '',
    ` — ${fmtStallMs(c.ms)}${c.running ? ' so far, still running' : ''}`
  ].join('')
  return {
    ...c,
    action,
    collection_label,
    user_name,
    page_label,
    sentence,
    likely: first && c.share >= LIKELY_SHARE
  }
}

interface NodeStalls {
  node: string
  role: string | null
  stalls: StallRecord[]
}

const sameRequestKind = (a: StallCulprit, b: StallCulprit) =>
  a.method === b.method && a.route === b.route && a.collection === b.collection

/**
 * The cause of the stalls on `nodes` (the processes that stalled): each node's worst stall with
 * its culprits in words, and one headline — the likely culprit of the worst stall, else the best
 * partial match, else "no request was running".
 */
export function describeStallCauses(nodes: NodeStalls[], labels: StallLabels): StallCauses {
  const views: StallCauseView[] = []
  for (const n of nodes) {
    if (n.stalls.length === 0) continue
    const worst = n.stalls.reduce((w, s) => (s.ms > w.ms ? s : w))
    views.push({
      node: n.node,
      role: n.role,
      at: worst.at,
      ms: worst.ms,
      stalls: n.stalls.length,
      culprits: worst.culprits.map((c, i) => viewCulprit(c, labels, i === 0))
    })
  }
  views.sort((a, b) => b.ms - a.ms)
  if (views.length === 0) return { headline: null, nodes: [] }

  const top = views.find((v) => v.culprits[0]?.likely) ?? null
  let headline: string
  if (top) {
    const c = top.culprits[0]
    // The same kind of request behind other stalls on the stalled nodes says it twice as loud.
    let behind = 0
    for (const n of nodes)
      for (const s of n.stalls)
        if (
          s.culprits[0] &&
          s.culprits[0].share >= LIKELY_SHARE &&
          sameRequestKind(s.culprits[0], c)
        )
          behind++
    headline = `Most likely cause: ${c.sentence}, on ${top.node}${
      behind > 1 ? ` (behind ${behind} stalls)` : ''
    }.`
  } else {
    const best = views.find((v) => v.culprits.length > 0)
    if (best) {
      const c = best.culprits[0]
      headline = `Possible cause: ${c.sentence}, on ${best.node} — it covers ${Math.round(
        c.share * 100
      )}% of the ${fmtStallMs(best.ms)} stall.`
    } else {
      headline = `No request was running on ${views[0].node} during its ${fmtStallMs(
        views[0].ms
      )} stall — likely background work (a scheduled job, socket traffic or garbage collection).`
    }
  }
  return { headline, nodes: views }
}

/** "2:14 PM EST" in the instance zone. */
export function clockAt(ms: number, zone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(11, 16)
  }
}

/** The detail lines for each stalled node's worst stall (under the per-node lines). */
export function stallCauseLines(causes: StallCauses, zone: string): string[] {
  const lines: string[] = []
  for (const v of causes.nodes.slice(0, 3)) {
    lines.push(
      `Worst stall on ${v.node}: ${fmtStallMs(v.ms)} at ${clockAt(v.at, zone)}${
        v.stalls > 1 ? ` (${v.stalls} stalls recorded)` : ''
      }. ${v.culprits.length ? 'Requests running then:' : 'No request was running then.'}`
    )
    v.culprits.forEach((c, i) => {
      const facts = [
        c.collection_label ? `${c.route} (${c.collection_label})` : c.route,
        c.user_name ?? 'no signed-in person',
        c.page_label ? `${c.page_label}${c.app ? ` in ${c.app}` : ''}` : null,
        `${fmtStallMs(c.ms)}${c.running ? ' so far' : ''}`,
        c.share >= 0.99 ? 'covered the whole stall' : `covered ${Math.round(c.share * 100)}%`,
        c.waiting_sql === true ? 'was waiting on the database' : null,
        `request ${c.id.slice(0, 36)}`
      ].filter(Boolean)
      lines.push(`  ${i + 1}. ${c.method} ${facts.join(', ')}`)
    })
  }
  return lines
}

/** Display names for the people and collections the records name (best effort). */
export async function stallLabels(records: StallRecord[], zone: string): Promise<StallLabels> {
  const { users, collections } = stallNames(records)
  const out: StallLabels = { users: new Map(), collections: new Map(), zone }
  if (!users.length && !collections.length) return out
  // Imported here so the pure half of this module (the judge's) never loads the database.
  const { db } = await import('../db/index.js')
  await Promise.all([
    users.length
      ? (
          db('nivaro_users')
            .whereIn('id', users)
            .select('id', 'first_name', 'last_name') as Promise<
            Array<{ id: string; first_name: string | null; last_name: string | null }>
          >
        )
          .then((rows) => {
            for (const r of rows) {
              const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
              if (name) out.users.set(String(r.id).toUpperCase(), name)
            }
          })
          .catch(() => {})
      : null,
    collections.length
      ? (
          db('nivaro_collections')
            .whereIn('collection', collections)
            .select('collection', 'display_name') as Promise<
            Array<{ collection: string; display_name: string | null }>
          >
        )
          .then((rows) => {
            for (const r of rows)
              out.collections.set(r.collection, collectionTitle(r.collection, r.display_name))
          })
          .catch(() => {})
      : null
  ])
  return out
}

const CAUSE_LINE = /^(Most likely cause|Possible cause): .+$|^No request was running on .+$/m

/** The cause line a freeze alert's stored detail carries (issue details, monitor detail), or null. */
export function causeFromDetail(detail: unknown): string | null {
  if (typeof detail !== 'string' || !detail) return null
  const m = CAUSE_LINE.exec(detail.slice(0, 4000))
  return m ? m[0].slice(0, 300) : null
}
