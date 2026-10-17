import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { embeddingProvider, embedText, searchEmbeddings } from '../services/embeddings.js'
import { createOne, ForbiddenError, updateOne } from '../services/items.js'
import { notifyUser } from '../services/notification-channels.js'
import { can } from '../services/permissions.js'
import { getLabels } from '../services/queues.js'
import type { User } from '../types.js'

/**
 * Idea board (migration 446). Ideas are rows of the real `ideas` collection,
 * so writes that matter to history (create, status, merge) go through the
 * items service; votes live in nivaro_idea_votes and only the cached
 * vote_count is written directly, so a vote never adds a revision.
 *
 * Reads are open to every signed-in person: the board is how people find out
 * whether something was already asked for. Status, merge and backlog links
 * are admin-only.
 */

const COLLECTION = 'ideas'
const STATUSES = ['under_review', 'planned', 'built', 'declined'] as const
type IdeaStatus = (typeof STATUSES)[number]
const STATUS_LABEL: Record<IdeaStatus, string> = {
  under_review: 'Under review',
  planned: 'Planned',
  built: 'Built',
  declined: 'Declined'
}
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Neural embeddings score unrelated text lower than the lexical hash does. */
const SEMANTIC_THRESHOLD = 0.45

interface IdeaRow {
  id: number
  title: string
  description: string | null
  status: IdeaStatus
  status_note: string | null
  merged_into: number | null
  vote_count: number
  created_by: string | null
  created_at: unknown
}

function ideaId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function loadIdea(id: number): Promise<IdeaRow | undefined> {
  return (await db(COLLECTION).where({ id }).first()) as IdeaRow | undefined
}

/** Recount from the vote table — the count can never drift from the votes. */
async function syncVoteCount(id: number): Promise<number> {
  const row = (await db('nivaro_idea_votes').where({ idea_id: id }).count('* as n').first()) as
    | { n: number | string }
    | undefined
  const n = Number(row?.n ?? 0)
  await db(COLLECTION).where({ id }).update({ vote_count: n })
  return n
}

async function votedIds(userId: string, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set()
  const rows = (await db('nivaro_idea_votes')
    .where({ user_id: userId })
    .whereIn('idea_id', ids)
    .select('idea_id')) as Array<{ idea_id: number }>
  return new Set(rows.map((r) => Number(r.idea_id)))
}

async function addVote(id: number, userId: string): Promise<void> {
  const exists = await db('nivaro_idea_votes').where({ idea_id: id, user_id: userId }).first('id')
  if (exists) return
  try {
    await db('nivaro_idea_votes').insert({ idea_id: id, user_id: userId })
  } catch {
    // a concurrent second click hit the unique pair — the vote already stands
  }
}

function tokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2)
    )
  ]
}

/** 0..1: how much of the query's words appear in the idea, title weighted. */
function textScore(q: string, qTokens: string[], idea: IdeaRow): number {
  if (qTokens.length === 0) return 0
  const title = idea.title.toLowerCase()
  const desc = (idea.description ?? '').toLowerCase()
  let hit = 0
  for (const t of qTokens) {
    if (title.includes(t)) hit += 1
    else if (desc.includes(t)) hit += 0.5
  }
  let score = hit / qTokens.length
  if (title.includes(q.toLowerCase().trim())) score = Math.max(score, 0.9)
  return Math.min(1, score)
}

function sendItemsError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof ForbiddenError) {
    return reply.code(403).send({ error: 'Your role may not add ideas' })
  }
  throw err
}

function shape(idea: IdeaRow, voted: boolean) {
  return {
    id: Number(idea.id),
    title: idea.title,
    description: idea.description,
    status: idea.status,
    status_note: idea.status_note,
    merged_into: idea.merged_into != null ? Number(idea.merged_into) : null,
    vote_count: Number(idea.vote_count ?? 0),
    created_by: idea.created_by,
    created_at: idea.created_at,
    voted
  }
}

export async function ideasRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string } }>(
    '/',
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = db(COLLECTION).whereNull('merged_into')
      const status = String(req.query.status ?? '')
      if ((STATUSES as readonly string[]).includes(status)) q.where({ status })
      const rows = (await q
        .orderBy('vote_count', 'desc')
        .orderBy('id', 'desc')
        .limit(500)) as IdeaRow[]
      const mine = await votedIds(
        req.user!.id,
        rows.map((r) => Number(r.id))
      )
      return reply.send({ data: rows.map((r) => shape(r, mine.has(Number(r.id)))) })
    }
  )

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/similar',
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = String(req.query.q ?? '')
        .trim()
        .slice(0, 300)
      const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 5))
      if (q.length < 2) return reply.send({ data: [] })

      const ideas = (await db(COLLECTION)
        .whereNull('merged_into')
        .select(
          'id',
          'title',
          'description',
          'status',
          'status_note',
          'merged_into',
          'vote_count',
          'created_by',
          'created_at'
        )
        .limit(5000)) as IdeaRow[]
      if (ideas.length === 0) return reply.send({ data: [] })

      const scores = new Map<number, number>()
      const qTokens = tokens(q)
      for (const idea of ideas) {
        const s = textScore(q, qTokens, idea)
        if (s > 0) scores.set(Number(idea.id), s)
      }

      // Meaning, when a real embedding model is set up — the lexical hash
      // fallback adds nothing the word match above has not already found.
      const provider = await embeddingProvider().catch(() => null)
      if (provider && provider.provider !== 'local') {
        try {
          const hits = await searchEmbeddings(COLLECTION, await embedText(q), 50)
          for (const h of hits) {
            if (h.score < SEMANTIC_THRESHOLD) continue
            const id = Number(h.item)
            scores.set(id, Math.max(scores.get(id) ?? 0, h.score))
          }
        } catch {
          // provider down — the text match still answers
        }
      }

      const byId = new Map(ideas.map((i) => [Number(i.id), i]))
      const ranked = [...scores.entries()]
        .filter(([id]) => byId.has(id)) // embeddings of merged ideas stay out
        .sort((a, b) => b[1] - a[1] || byId.get(b[0])!.vote_count - byId.get(a[0])!.vote_count)
        .slice(0, limit)
      const mine = await votedIds(
        req.user!.id,
        ranked.map(([id]) => id)
      )
      return reply.send({
        data: ranked.map(([id, score]) => ({
          ...shape(byId.get(id)!, mine.has(id)),
          score: Math.round(score * 100) / 100
        }))
      })
    }
  )

  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = ideaId(req.params.id)
    const idea = id ? await loadIdea(id) : undefined
    if (!id || !idea) return reply.code(404).send({ error: 'Not found' })

    const mine = await votedIds(req.user!.id, [id])
    const mergedInto = idea.merged_into
      ? ((await db(COLLECTION).where({ id: idea.merged_into }).first('id', 'title')) as
          | { id: number; title: string }
          | undefined)
      : undefined
    const mergedFrom = (await db(COLLECTION)
      .where({ merged_into: id })
      .select('id', 'title')) as Array<{ id: number; title: string }>

    // Status history: every revision whose change touched status or the note.
    const revs = (await db('nivaro_revisions as r')
      .leftJoin('nivaro_activity as a', 'a.id', 'r.activity')
      .leftJoin('nivaro_users as u', 'u.id', 'a.user')
      .where({ 'r.collection': COLLECTION, 'r.item': String(id) })
      .orderBy('r.id', 'asc')
      .select('r.data', 'r.delta', 'a.timestamp', 'u.first_name', 'u.last_name')) as Array<
      Record<string, unknown>
    >
    const history: Array<{ at: unknown; by: string | null; status: string; note: string | null }> =
      []
    for (const r of revs) {
      let data: Record<string, unknown> = {}
      let delta: Record<string, unknown> | null = null
      try {
        data = JSON.parse(String(r.data ?? '{}'))
        delta = r.delta ? JSON.parse(String(r.delta)) : null
      } catch {
        continue
      }
      const touched = !delta || 'status' in delta || 'status_note' in delta
      if (!touched || !data.status) continue
      const by = [r.first_name, r.last_name].filter(Boolean).join(' ') || null
      history.push({
        at: r.timestamp,
        by,
        status: String(data.status),
        note: (data.status_note as string | null) ?? null
      })
    }

    const links = await ideaLinks(id, req.user!)
    return reply.send({
      data: {
        ...shape(idea, mine.has(id)),
        merged_into_title: mergedInto?.title ?? null,
        merged_from: mergedFrom.map((m) => ({ id: Number(m.id), title: m.title })),
        history,
        links
      }
    })
  })

  app.post<{ Body: { title?: string; description?: string } }>(
    '/',
    { preHandler: requireAuth },
    async (req, reply) => {
      const title = String(req.body?.title ?? '')
        .trim()
        .slice(0, 255)
      const description = String(req.body?.description ?? '').trim() || null
      if (!title) return reply.code(400).send({ error: 'A title is required' })
      let created: Record<string, unknown> | null
      try {
        created = (await createOne(
          req.user!,
          COLLECTION,
          { title, description, status: 'under_review', vote_count: 0 },
          req,
          req.workspaceId ?? undefined
        )) as Record<string, unknown> | null
      } catch (err) {
        return sendItemsError(err, reply)
      }
      const id = Number(created?.id)
      await addVote(id, req.user!.id)
      await syncVoteCount(id)
      const idea = await loadIdea(id)
      return reply.code(201).send({ data: idea ? shape(idea, true) : { id } })
    }
  )

  const vote = (on: boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const id = ideaId((req.params as { id: string }).id)
    const idea = id ? await loadIdea(id) : undefined
    if (!id || !idea) return reply.code(404).send({ error: 'Not found' })
    if (on && idea.merged_into) {
      return reply
        .code(409)
        .send({ error: 'This idea was merged — vote on the idea it was merged into' })
    }
    if (on) await addVote(id, req.user!.id)
    else await db('nivaro_idea_votes').where({ idea_id: id, user_id: req.user!.id }).delete()
    const vote_count = await syncVoteCount(id)
    return reply.send({ data: { id, voted: on, vote_count } })
  }
  app.post('/:id/vote', { preHandler: requireAuth }, vote(true))
  app.delete('/:id/vote', { preHandler: requireAuth }, vote(false))

  app.patch<{ Params: { id: string }; Body: { status?: string; note?: string | null } }>(
    '/:id/status',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = ideaId(req.params.id)
      const idea = id ? await loadIdea(id) : undefined
      if (!id || !idea) return reply.code(404).send({ error: 'Not found' })
      const status = String(req.body?.status ?? '') as IdeaStatus
      if (!STATUSES.includes(status)) {
        return reply.code(400).send({ error: `status must be one of ${STATUSES.join(', ')}` })
      }
      const note = String(req.body?.note ?? '').trim() || null
      await updateOne(
        req.user!,
        COLLECTION,
        id,
        { status, status_note: note },
        req,
        req.workspaceId ?? undefined
      )

      const voters = await voterIds(id)
      const label = STATUS_LABEL[status]
      for (const userId of voters) {
        await notifyUser(req.server, userId, {
          subject: `Idea "${idea.title}" is now ${label}`,
          message: note ? `Status: ${label}. Note: ${note}` : `Status: ${label}.`,
          sender: req.user!.id,
          collection: COLLECTION,
          item: String(id),
          category: 'other',
          why: 'You voted for this idea.',
          target: { kind: 'record', collection: COLLECTION, id, action: 'open' }
        }).catch(() => undefined)
      }
      const updated = await loadIdea(id)
      return reply.send({
        data: { ...shape(updated ?? idea, voters.includes(req.user!.id)), notified: voters.length }
      })
    }
  )

  app.post<{ Params: { id: string }; Body: { into?: number | string } }>(
    '/:id/merge',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = ideaId(req.params.id)
      const into = ideaId(String(req.body?.into ?? ''))
      const source = id ? await loadIdea(id) : undefined
      const target = into ? await loadIdea(into) : undefined
      if (!id || !source) return reply.code(404).send({ error: 'Not found' })
      if (!into || !target) return reply.code(400).send({ error: 'Pick the idea to merge into' })
      if (into === id) return reply.code(400).send({ error: 'An idea cannot merge into itself' })
      if (source.merged_into) return reply.code(400).send({ error: 'This idea is already merged' })
      if (target.merged_into) {
        return reply
          .code(400)
          .send({ error: 'That idea was itself merged — pick the one it went to' })
      }

      const sourceVoters = await voterIds(id)
      // Move the votes: a voter already on the target keeps their one vote.
      // The target's voters are read up front because MySQL rejects an UPDATE
      // whose subquery reads the same table (ER_UPDATE_TABLE_USED).
      await db.transaction(async (trx) => {
        const targetVoters = (
          await trx('nivaro_idea_votes').where({ idea_id: into }).select('user_id')
        ).map((r: { user_id: string }) => r.user_id)
        const move = trx('nivaro_idea_votes').where({ idea_id: id })
        if (targetVoters.length) move.whereNotIn('user_id', targetVoters)
        await move.update({ idea_id: into })
        await trx('nivaro_idea_votes').where({ idea_id: id }).delete()
        // Ideas merged earlier into the source follow it to the target.
        await trx(COLLECTION).where({ merged_into: id }).update({ merged_into: into })
      })
      await syncVoteCount(id)
      const vote_count = await syncVoteCount(into)
      // The record stays (history, links); merged_into hides it from the board.
      // Set only once the votes have moved, so a failure never leaves it half-merged.
      await updateOne(
        req.user!,
        COLLECTION,
        id,
        { merged_into: into },
        req,
        req.workspaceId ?? undefined
      )

      for (const userId of sourceVoters) {
        await notifyUser(req.server, userId, {
          subject: `Idea "${source.title}" was merged`,
          message: `It was merged into "${target.title}", and your vote moved there.`,
          sender: req.user!.id,
          collection: COLLECTION,
          item: String(into),
          category: 'other',
          why: 'You voted for the merged idea.',
          target: { kind: 'record', collection: COLLECTION, id: into, action: 'open' }
        }).catch(() => undefined)
      }
      return reply.send({ data: { id, merged_into: into, vote_count } })
    }
  )

  app.post<{ Params: { id: string }; Body: { collection?: string; id?: string | number } }>(
    '/:id/link',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = ideaId(req.params.id)
      if (!id || !(await loadIdea(id))) return reply.code(404).send({ error: 'Not found' })
      const tc = String(req.body?.collection ?? '').trim()
      const ti = String(req.body?.id ?? '').trim()
      if (!tc || !ti) return reply.code(400).send({ error: 'collection and id are required' })
      if (!IDENT_RE.test(tc) || /^(nivaro|directus)_/i.test(tc)) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      if (tc === COLLECTION && ti === String(id)) {
        return reply.code(400).send({ error: 'An idea cannot link to itself' })
      }
      if (!(await db('nivaro_collections').where({ collection: tc }).first('id'))) {
        return reply.code(400).send({ error: 'Not a valid collection' })
      }
      const record = await db(tc)
        .where({ id: ti })
        .first('id')
        .catch(() => null)
      if (!record) return reply.code(404).send({ error: 'That record does not exist' })

      const key = {
        from_collection: COLLECTION,
        from_item: String(id),
        to_collection: tc,
        to_item: ti
      }
      if (await db('nivaro_record_links').where(key).first('id')) {
        return reply.code(409).send({ error: 'Already linked' })
      }
      await db('nivaro_record_links').insert({
        ...key,
        link_type: 'relates to',
        note: 'Idea board backlog link',
        created_by: req.user!.id
      })
      void logActivity({
        action: 'record-link-create',
        user: req.user!.id,
        collection: COLLECTION,
        item: String(id),
        comment: `relates to ${tc}/${ti}`,
        req
      })
      return reply.code(201).send({ data: { links: await ideaLinks(id, req.user!) } })
    }
  )
}

async function voterIds(id: number): Promise<string[]> {
  const rows = (await db('nivaro_idea_votes').where({ idea_id: id }).select('user_id')) as Array<{
    user_id: string
  }>
  return rows.map((r) => String(r.user_id))
}

/** The idea's record links (either direction), labelled where the viewer may
 *  read the other end — same posture as the record-links route. */
async function ideaLinks(id: number, user: User) {
  const [outgoing, incoming] = await Promise.all([
    db('nivaro_record_links').where({ from_collection: COLLECTION, from_item: String(id) }),
    db('nivaro_record_links').where({ to_collection: COLLECTION, to_item: String(id) })
  ])
  const ends = [
    ...outgoing.map((l) => ({ l, c: String(l.to_collection), i: String(l.to_item) })),
    ...incoming.map((l) => ({ l, c: String(l.from_collection), i: String(l.from_item) }))
  ]
  const wanted = new Map<string, Set<string>>()
  for (const e of ends) wanted.set(e.c, (wanted.get(e.c) ?? new Set()).add(e.i))
  for (const c of [...wanted.keys()]) {
    if (!(await can(user, 'read', c))) wanted.delete(c)
  }
  const labels: Record<string, string> =
    wanted.size > 0 ? await getLabels(wanted).catch(() => ({})) : {}
  return ends.map((e) => ({
    id: Number(e.l.id),
    type: String(e.l.link_type ?? 'relates to'),
    collection: e.c,
    item: e.i,
    label: labels[`${e.c}:${e.i}`] ?? null
  }))
}
