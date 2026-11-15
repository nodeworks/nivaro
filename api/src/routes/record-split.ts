import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAuth } from '../middleware/authenticate.js'
import { resolveWorkspace } from '../middleware/workspace.js'
import { describeWriteRefusal, ForbiddenError } from '../services/items.js'
import { recordDisplayRefs } from '../services/record-display-ref.js'
import { registerNoteSource } from '../services/record-notes.js'
import {
  parseSplitComment,
  SPLIT_IN,
  SPLIT_OUT,
  SplitRefusal,
  splitNoteText,
  splitRecord
} from '../services/record-split.js'

/**
 * Split a record's lines into a new record (services/record-split.ts):
 *
 *   POST /record-split/:collection/:id  {relation: '<child>.<link field>', line_ids: [...], values?}
 *     → 201 {data: {id, readable, moved, relation, field, link_failures}}
 *
 * and the Notes-thread source that names the other record on both sides.
 */
export async function recordSplitRoutes(app: FastifyInstance) {
  registerNoteSource({
    key: 'record-splits',
    // A person's own action, written by the server: shown as is.
    machine: true,
    async load({ collection, item, viewerId, cap }) {
      const rows = (await db('nivaro_activity')
        .where({ collection, item: String(item) })
        .whereIn('action', [SPLIT_OUT, SPLIT_IN])
        .orderBy('timestamp', 'desc')
        .limit(Math.min(cap, 50))
        .select('id', 'user', 'timestamp', 'action', 'comment')
        .catch(() => [])) as Array<Record<string, unknown>>
      const parsed = rows
        .map((r) => ({ r, s: parseSplitComment(String(r.action ?? ''), r.comment) }))
        .filter((x): x is { r: Record<string, unknown>; s: NonNullable<typeof x.s> } => !!x.s)
      if (parsed.length === 0) return []
      // The other record named as the READER may see it (#id when they may not).
      const refs = await recordDisplayRefs(
        collection,
        parsed.map((x) => x.s.other),
        { recipient: viewerId }
      ).catch(() => new Map<string, string>())
      return parsed.map(({ r, s }) => ({
        id: `split:${r.id}`,
        source: 'change_reason' as const,
        label: s.direction === 'out' ? 'Split' : 'Split from',
        text: splitNoteText(s),
        user: (r.user as string) ?? null,
        created_at: r.timestamp as string,
        context: refs.get(s.other) ?? `#${s.other}`,
        link: { collection, item_id: s.other },
        origin: 'person' as const
      }))
    }
  })

  app.post<{ Params: { collection: string; id: string } }>(
    '/:collection/:id',
    { preHandler: [requireAuth, resolveWorkspace] },
    async (req, reply) => {
      const { collection, id } = req.params
      try {
        const data = await splitRecord(req, collection, id, (req.body ?? {}) as never)
        return reply.code(201).send({ data })
      } catch (err) {
        if (err instanceof SplitRefusal)
          return reply
            .code(err.statusCode)
            .send({ error: err.message, code: err.code, ...err.extra })
        if (err instanceof ForbiddenError)
          return reply.code(403).send({ error: 'You cannot make this change.', code: 'FORBIDDEN' })
        const why = describeWriteRefusal(err)
        if (why.status >= 500) {
          req.log.error({ err }, 'record split failed')
          return reply
            .code(500)
            .send({ error: 'The lines could not be moved. Nothing was changed.' })
        }
        const { status, ...rest } = why
        return reply.code(status).send(rest)
      }
    }
  )
}
