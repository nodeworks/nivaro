import { db } from '../../db/index.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import { cosineSim, embedText } from '../embeddings.js'
import { groupSimilarIssues } from '../issue-groups.js'
import { getConnection, providerFor, type TrackerConnection } from './connections.js'
import { queueExample, queueSourceExample } from './examples.js'
import { trackersEnabled } from './feature.js'
import { loadIssue } from './issue-body.js'
import {
  addMember,
  addSourceMember,
  LINKS,
  MEMBERS,
  memberFor,
  memberForSource,
  projectPathFrom,
  SOURCE_ISSUE,
  upsertLinkFromRemote
} from './link-store.js'
import { LinkError } from './links.js'
import type { SourceView } from './sources/types.js'
import type { RemoteIssue } from './types.js'

export { type ExampleNoteVars, exampleNoteBody } from './examples.js'

/**
 * Where a Nivaro issue belongs before anything new is opened on GitLab: a link with the same
 * fingerprint, a link holding another issue of its group, or an open GitLab issue that reads the
 * same (embedding cosine over normalised title + first 500 chars of details). Joining makes the
 * issue an example on that GitLab issue (one note + on_example labels).
 *
 * findSimilar / findHome never throw to their callers: a GitLab or embedder failure counts as
 * "no candidates" (logged once per call).
 */

const DAY_MS = 86_400_000
const LINK_WINDOW_DAYS = 90
const MAX_LINK_CANDIDATES = 50
const MAX_SEARCH_CANDIDATES = 20
const BODY_CHARS = 500
const KEY_WORDS = 6
const KEY_WORD_MIN = 4

export interface SimilarCandidate {
  link_id: number | null
  project_id: number
  iid: number
  web_url: string
  title: string
  score: number
  linked: boolean
}

export type HomeVia = 'fingerprint' | 'group' | 'similar'

type Row = Record<string, unknown>

/**
 * The text that is embedded: title + the first 500 characters of the body, lower-cased, with
 * uuids, quoted names and numbers folded away. The folds are the ones normalizeForGrouping in
 * services/issue-groups.ts uses (copied: that helper also cuts the result at 400 characters).
 */
export function normalizeForSimilarity(title: string, body: string | null): string {
  const text = `${String(title ?? '')} ${String(body ?? '').slice(0, BODY_CHARS)}`
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/'[^']{1,80}'/g, "'<x>'")
    .replace(/"[^"]{1,80}"/g, '"<x>"')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Distinct words of 4+ characters, longest first (equal lengths keep their order in the title). */
function rankedWords(normalizedTitle: string): string[] {
  const seen = new Set<string>()
  const words: string[] = []
  for (const w of normalizedTitle.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < KEY_WORD_MIN || seen.has(w)) continue
    seen.add(w)
    words.push(w)
  }
  return words
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w.length - a.w.length || a.i - b.i)
    .map((x) => x.w)
}

/** The GitLab title-search words: the 6 longest distinct words of 4+ characters. */
export function keyWords(normalizedTitle: string): string {
  return rankedWords(normalizedTitle).slice(0, KEY_WORDS).join(' ')
}

const FALLBACK_WORDS = 3
const SINGLE_WORD_MIN = 6

/**
 * The title searches to try, in order. GitLab's title search needs EVERY term to appear, so a
 * search that finds nothing is retried with fewer words: the 6 longest, then the 3 longest, then
 * (when the title has 2+ words) the single longest word of 6+ characters. At most 3, no repeats.
 */
export function searchQueries(normalizedTitle: string): string[] {
  const words = rankedWords(normalizedTitle)
  if (!words.length) return []
  const out = [words.slice(0, KEY_WORDS).join(' '), words.slice(0, FALLBACK_WORDS).join(' ')]
  if (words.length >= 2 && words[0].length >= SINGLE_WORD_MIN) out.push(words[0])
  return [...new Set(out)]
}

function onceLogger(): (what: string, err: unknown) => void {
  let logged = false
  return (what, err) => {
    if (logged) return
    logged = true
    // biome-ignore lint/suspicious/noConsole: a matching failure must be visible in the server log
    console.warn(
      `[trackers] similar-ticket matching: ${what} failed — treated as no candidates: ${
        err instanceof Error ? err.message : String(err)
      }`.slice(0, 500)
    )
  }
}

interface Pending {
  link_id: number | null
  project_id: number
  iid: number
  web_url: string
  title: string
  text: string
}

/** Open links on the connection from the last 90 days, newest 50, with the text they stand for. */
async function linkCandidates(connection: number, exclude: number | null): Promise<Pending[]> {
  const since = new Date(Date.now() - LINK_WINDOW_DAYS * DAY_MS)
  const links = (
    (await db(LINKS)
      .where({ connection, remote_state: 'opened' })
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(MAX_LINK_CANDIDATES + 1)
      .select('id', 'project_id', 'external_iid', 'web_url', 'remote_title')) as Row[]
  )
    .filter((l) => Number(l.id) !== exclude)
    .slice(0, MAX_LINK_CANDIDATES)
  if (!links.length) return []

  // A link's GitLab description is built from its lead Nivaro issue, so that issue's own title +
  // details stand in for it (no GitLab read per link). No readable lead → the mirrored title.
  const linkIds = links.map((l) => Number(l.id))
  const members = await selectInChunks(
    linkIds,
    500,
    async (chunk) =>
      (await whereInList(db(MEMBERS), 'link', chunk)
        .where({ source_kind: SOURCE_ISSUE })
        .select('link', 'source_id', 'joined_via')) as Row[]
  )
  const leadOf = new Map<number, { id: number; lead: boolean }>()
  for (const m of members) {
    const link = Number(m.link)
    const id = Number(m.source_id)
    if (!Number.isFinite(id)) continue
    const lead = m.joined_via === 'lead'
    const cur = leadOf.get(link)
    if (!cur || (!cur.lead && (lead || id < cur.id))) leadOf.set(link, { id, lead })
  }
  const issueIds = [...new Set([...leadOf.values()].map((v) => v.id))].map(String)
  const issues = await selectInChunks(
    issueIds,
    500,
    async (chunk) =>
      (await whereInList(db('nivaro_issues'), 'id', chunk).select(
        'id',
        'title',
        'details'
      )) as Row[]
  )
  const byId = new Map(issues.map((i) => [Number(i.id), i]))
  return links.map((l) => {
    const lead = byId.get(leadOf.get(Number(l.id))?.id ?? -1)
    const title = String(l.remote_title ?? '')
    return {
      link_id: Number(l.id),
      project_id: Number(l.project_id),
      iid: Number(l.external_iid),
      web_url: String(l.web_url ?? ''),
      title,
      text: lead
        ? normalizeForSimilarity(
            String(lead.title ?? ''),
            lead.details == null ? null : String(lead.details)
          )
        : normalizeForSimilarity(title, null)
    }
  })
}

/** Every candidate scored against the issue, best first. Never throws. */
async function scoreCandidates(
  issue: Row,
  conn: TrackerConnection,
  projectId: number
): Promise<SimilarCandidate[]> {
  let own: Row | undefined
  try {
    own = await memberFor(conn.id, Number(issue.id))
  } catch (err) {
    onceLogger()('finding candidates', err)
    return []
  }
  return scoreText(
    String(issue.title ?? ''),
    issue.details == null ? null : String(issue.details),
    own ? Number(own.link) : null,
    conn,
    projectId
  )
}

/** Every candidate scored against this text (title + body), best first. Never throws. */
async function scoreText(
  title: string,
  details: string | null,
  ownLink: number | null,
  conn: TrackerConnection,
  projectId: number
): Promise<SimilarCandidate[]> {
  const log = onceLogger()
  try {
    let source: number[]
    try {
      source = await embedText(normalizeForSimilarity(title, details))
    } catch (err) {
      log('embedding the issue', err)
      return []
    }

    const pending = await linkCandidates(conn.id, ownLink)
    const seen = new Set(pending.map((p) => `${p.project_id}:${p.iid}`))

    // Fewer words until a search finds something (at most 3 GitLab calls).
    const queries = projectId ? searchQueries(normalizeForSimilarity(title, null)) : []
    let found: RemoteIssue[] = []
    if (queries.length) {
      try {
        const provider = await providerFor(conn.id)
        for (const q of queries) {
          found = (await provider.searchOpenIssues(projectId, q)).slice(0, MAX_SEARCH_CANDIDATES)
          if (found.length) break
        }
      } catch (err) {
        log('the GitLab title search', err)
        found = []
      }
    }
    const fresh = found.filter((r) => !seen.has(`${r.project_id}:${r.iid}`))
    // Search hits Nivaro already links (older than the window, say) are links too.
    const known = new Map<string, number>()
    if (fresh.length) {
      const rows = (await whereInList(
        db(LINKS).where({ connection: conn.id, project_id: projectId }),
        'external_iid',
        fresh.map((r) => r.iid)
      ).select('id', 'project_id', 'external_iid')) as Row[]
      for (const r of rows)
        known.set(`${Number(r.project_id)}:${Number(r.external_iid)}`, Number(r.id))
    }
    for (const r of fresh) {
      const key = `${r.project_id}:${r.iid}`
      if (seen.has(key)) continue
      seen.add(key)
      const linkId = known.get(key) ?? null
      if (linkId !== null && linkId === ownLink) continue
      pending.push({
        link_id: linkId,
        project_id: r.project_id,
        iid: r.iid,
        web_url: r.web_url,
        title: r.title,
        text: normalizeForSimilarity(r.title, r.description)
      })
    }

    const out: SimilarCandidate[] = []
    for (const p of pending) {
      let vec: number[]
      try {
        vec = await embedText(p.text)
      } catch (err) {
        log('embedding a candidate', err)
        continue
      }
      out.push({
        link_id: p.link_id,
        project_id: p.project_id,
        iid: p.iid,
        web_url: p.web_url,
        title: p.title,
        score: cosineSim(source, vec),
        linked: p.link_id !== null
      })
    }
    return out.sort((a, b) => b.score - a.score)
  } catch (err) {
    log('finding candidates', err)
    return []
  }
}

/** Candidates at or above the connection's `suggest_at`, best first (default 10). */
export async function findSimilar(
  issueId: number,
  connection: number,
  projectId: number,
  opts: { limit?: number } = {}
): Promise<SimilarCandidate[]> {
  try {
    if (!(await trackersEnabled())) return []
    const conn = await getConnection(connection)
    // Similar matching off for this connection: no GitLab search, no embeddings.
    if (!conn?.sync?.similar?.enabled) return []
    const issue = await loadIssue(issueId)
    if (!conn || !issue) return []
    const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit) || 10)))
    const all = await scoreCandidates(issue, conn, projectId)
    return all.filter((c) => c.score >= conn.sync.similar.suggest_at).slice(0, limit)
  } catch (err) {
    onceLogger()('findSimilar', err)
    return []
  }
}

/** Newest link on this connection holding one of these issues. */
async function linkHolding(connection: number, issueIds: number[]): Promise<number | null> {
  const keys = [...new Set(issueIds.filter((n) => Number.isFinite(n)).map(String))]
  if (!keys.length) return null
  const rows = await selectInChunks(
    keys,
    500,
    async (chunk) =>
      (await whereInList(db(MEMBERS), 'source_id', chunk)
        .where({ connection, source_kind: SOURCE_ISSUE })
        .select('link')) as Row[]
  )
  const ids = rows.map((r) => Number(r.link)).filter((n) => Number.isFinite(n))
  return ids.length ? Math.max(...ids) : null
}

const MAX_SAME_FINGERPRINT = 500

/**
 * The newest link on this connection for this fingerprint: a link carrying it, or a link holding
 * another issue with it. Null = none.
 */
export async function fingerprintLink(
  connection: number,
  issueId: number,
  fingerprint: string
): Promise<number | null> {
  const byLink = (await db(LINKS)
    .where({ connection, fingerprint })
    .orderBy('id', 'desc')
    .first('id')) as Row | undefined
  const same = (await db('nivaro_issues')
    .where({ fingerprint })
    .whereNot({ id: issueId })
    .orderBy('id', 'desc')
    .limit(MAX_SAME_FINGERPRINT)
    .select('id')) as Row[]
  const byMember = await linkHolding(
    connection,
    same.map((r) => Number(r.id))
  )
  const best = Math.max(byLink ? Number(byLink.id) : -1, byMember ?? -1)
  return best > 0 ? best : null
}

/**
 * Where this issue belongs on this connection: (1) a link with its fingerprint (or holding an
 * issue with its fingerprint), (2) a link holding another issue of its current group, (3) the
 * best similar candidate at or above `join_at` when similar matching is on. Null = nowhere (or
 * already linked here). Never throws.
 */
export async function findHome(
  issueId: number,
  connection: number,
  projectId: number
): Promise<{ via: HomeVia; link_id: number | null; candidate?: SimilarCandidate } | null> {
  const log = onceLogger()
  try {
    if (!(await trackersEnabled())) return null
    const conn = await getConnection(connection)
    const issue = await loadIssue(issueId)
    if (!conn || !issue) return null
    if (await memberFor(connection, issueId)) return null

    const fp = issue.fingerprint ? String(issue.fingerprint) : ''
    if (fp) {
      const best = await fingerprintLink(connection, issueId, fp)
      if (best !== null) return { via: 'fingerprint', link_id: best }
    }

    try {
      const groups = await groupSimilarIssues()
      const mine = groups.find(
        (g) => g.lead.id === issueId || g.variants.some((v) => v.id === issueId)
      )
      if (mine) {
        const others = [mine.lead.id, ...mine.variants.map((v) => v.id)].filter(
          (id) => id !== issueId
        )
        const link = await linkHolding(connection, others)
        if (link !== null) return { via: 'group', link_id: link }
      }
    } catch (err) {
      log('reading issue groups', err)
    }

    if (conn.sync.similar.enabled) {
      const best = (await scoreCandidates(issue, conn, projectId))[0]
      if (best && best.score >= conn.sync.similar.join_at)
        return { via: 'similar', link_id: best.link_id, candidate: best }
    }
    return null
  } catch (err) {
    log('findHome', err)
    return null
  }
}

/**
 * Add the issue as an example on a GitLab issue: an existing link, or a GitLab issue by project +
 * iid (a GitLab issue Nivaro did not open becomes a `linked` link). A NEW member gets one example
 * note (key `example:<link>:<issue>`) + the connection's on_example labels; a repeat adds nothing.
 * Returns the link id.
 */
export async function joinAsExample(
  issueId: number,
  connection: number,
  target: { link_id: number } | { project_id: number; iid: number },
  via: 'fingerprint' | 'group' | 'similar' | 'manual',
  score?: number
): Promise<number> {
  if (!(await trackersEnabled()))
    throw new LinkError('GitLab sync is turned off', 404, 'FEATURE_OFF')
  const issue = await loadIssue(issueId)
  if (!issue) throw new LinkError('Issue not found', 404, 'NOT_FOUND')
  const conn = await getConnection(connection)
  if (!conn) throw new LinkError('Connection not found', 404, 'CONNECTION_NOT_FOUND')

  let linkId: number
  if ('link_id' in target) {
    const link = (await db(LINKS).where({ id: target.link_id }).first('id', 'connection')) as
      | Row
      | undefined
    if (!link || Number(link.connection) !== connection)
      throw new LinkError('Link not found', 404, 'NOT_FOUND')
    linkId = Number(link.id)
  } else {
    const projectId = Number(target.project_id)
    const iid = Number(target.iid)
    if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(iid) || iid <= 0)
      throw new LinkError('Name the GitLab project and issue number', 400, 'INVALID_TARGET')
    const existing = (await db(LINKS)
      .where({ connection, project_id: projectId, external_iid: iid })
      .first('id')) as Row | undefined
    if (existing) linkId = Number(existing.id)
    else {
      if (await memberFor(connection, issueId))
        throw new LinkError(
          'This issue already has a GitLab issue on this connection',
          409,
          'ALREADY_LINKED'
        )
      const remote = await (await providerFor(connection)).getIssue(projectId, iid)
      linkId = await upsertLinkFromRemote(connection, remote, {
        project_path: projectPathFrom(remote.web_url, conn.base_url),
        created_via: 'linked',
        fingerprint: issue.fingerprint ? String(issue.fingerprint) : null,
        created_by: null
      })
    }
  }

  const res = await addMember(linkId, connection, issueId, via)
  if (res === 'conflict')
    throw new LinkError(
      'This issue already has a GitLab issue on this connection',
      409,
      'ALREADY_LINKED'
    )
  if (res === 'added') await queueExample(linkId, issueId, via === 'similar' ? score : undefined)
  return linkId
}

// ── Tickets and records ───────────────────────────────────────────────────────

/** findSimilar for a ticket / record (text = its title + body). Never throws. */
export async function findSimilarForSource(
  view: SourceView,
  connection: number,
  projectId: number,
  opts: { limit?: number } = {}
): Promise<SimilarCandidate[]> {
  try {
    if (view.kind === 'issue') return findSimilar(Number(view.id), connection, projectId, opts)
    if (!(await trackersEnabled())) return []
    const conn = await getConnection(connection)
    if (!conn?.sync?.similar?.enabled) return []
    const own = await memberForSource(connection, view.kind, view.id)
    const limit = Math.max(1, Math.min(100, Math.floor(Number(opts.limit) || 10)))
    const all = await scoreText(
      view.title,
      view.body,
      own ? Number(own.link) : null,
      conn,
      projectId
    )
    return all.filter((c) => c.score >= conn.sync.similar.suggest_at).slice(0, limit)
  } catch (err) {
    onceLogger()('findSimilar', err)
    return []
  }
}

/**
 * findHome for a ticket / record: only the similar step applies (no fingerprints, no issue
 * groups). Null = nowhere (or already linked here). Never throws.
 */
export async function findHomeForSource(
  view: SourceView,
  connection: number,
  projectId: number
): Promise<{ via: HomeVia; link_id: number | null; candidate?: SimilarCandidate } | null> {
  try {
    if (view.kind === 'issue') return findHome(Number(view.id), connection, projectId)
    if (!(await trackersEnabled())) return null
    const conn = await getConnection(connection)
    if (!conn) return null
    if (await memberForSource(connection, view.kind, view.id)) return null
    if (!conn.sync.similar.enabled) return null
    const best = (await scoreText(view.title, view.body, null, conn, projectId))[0]
    if (best && best.score >= conn.sync.similar.join_at)
      return { via: 'similar', link_id: best.link_id, candidate: best }
    return null
  } catch (err) {
    onceLogger()('findHome', err)
    return null
  }
}

/** joinAsExample for a ticket / record. Returns the link id. */
export async function joinSourceAsExample(
  view: SourceView,
  connection: number,
  target: { link_id: number } | { project_id: number; iid: number },
  via: 'similar' | 'manual',
  score?: number
): Promise<number> {
  if (view.kind === 'issue') return joinAsExample(Number(view.id), connection, target, via, score)
  if (!(await trackersEnabled()))
    throw new LinkError('GitLab sync is turned off', 404, 'FEATURE_OFF')
  const conn = await getConnection(connection)
  if (!conn) throw new LinkError('Connection not found', 404, 'CONNECTION_NOT_FOUND')
  let linkId: number
  if ('link_id' in target) {
    const link = (await db(LINKS).where({ id: target.link_id }).first('id', 'connection')) as
      | Row
      | undefined
    if (!link || Number(link.connection) !== connection)
      throw new LinkError('Link not found', 404, 'NOT_FOUND')
    linkId = Number(link.id)
  } else {
    const projectId = Number(target.project_id)
    const iid = Number(target.iid)
    if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(iid) || iid <= 0)
      throw new LinkError('Name the GitLab project and issue number', 400, 'INVALID_TARGET')
    const existing = (await db(LINKS)
      .where({ connection, project_id: projectId, external_iid: iid })
      .first('id')) as Row | undefined
    if (existing) linkId = Number(existing.id)
    else {
      if (await memberForSource(connection, view.kind, view.id))
        throw new LinkError(
          'This already has a GitLab issue on this connection',
          409,
          'ALREADY_LINKED'
        )
      const remote = await (await providerFor(connection)).getIssue(projectId, iid)
      linkId = await upsertLinkFromRemote(connection, remote, {
        project_path: projectPathFrom(remote.web_url, conn.base_url),
        created_via: 'linked',
        fingerprint: null,
        created_by: null
      })
    }
  }
  const res = await addSourceMember(linkId, connection, view.kind, view.id, via)
  if (res === 'conflict')
    throw new LinkError('This already has a GitLab issue on this connection', 409, 'ALREADY_LINKED')
  if (res === 'added') await queueSourceExample(linkId, view, via === 'similar' ? score : undefined)
  return linkId
}
