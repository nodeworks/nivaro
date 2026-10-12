import { AsyncLocalStorage } from 'node:async_hooks'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { currentSeq, replaySince } from '../services/event-journal.js'
import { collectionChangeOf, onJournalEntry } from '../services/journal-listeners.js'
import {
  bindFromRequest,
  checkBind,
  parseWsTokenValue,
  type SocketBind,
  userWithApiKey
} from '../services/socket-access.js'
import { currentTenantKey, tenantScopedRoom } from '../services/tenant-rooms.js'
import {
  frameText,
  loadSnapshot,
  openView,
  type SavedViewRow,
  saveSnapshot,
  snapshotKey,
  type ViewCondition,
  ViewStreamSession
} from '../services/view-stream.js'
import type { User } from '../types.js'

// ─── Saved-view change stream (#1680) ────────────────────────────────────────
// GET /events/views/:id/stream — the SSE event stream narrowed to one saved view, judged as
// the caller (services/view-stream.ts). Auth is the event stream's: a Bearer header (an API
// key, a static token) or a session, or — for a header-less EventSource — the one-shot
// `?ticket=` from GET /events/ticket (60s, single use; the ticket keeps what signed it in).
//
// Events (SSE `id:` = the journal sequence; send it back as Last-Event-ID to resume):
//   ready          { view, collection, resumed }        once, after the baseline
//   record.change  { item, action, changed_fields, entered?, values? }
//   record.leave   { item }       stopped matching the view (or the caller lost sight of it)
//   record.delete  { item }       deleted while in the view
//   view.refresh   { reason }     a bulk write: re-read the view
//   reset          { reason }     cannot replay from your cursor: re-read the view
//   view.closed    { reason }     the view is gone or no longer yours to read
//   session.ended  { reason }     the sign-in ended (signed out, key revoked or expired)

const HEARTBEAT_MS = 25_000

async function redeemTicket(
  app: FastifyInstance,
  ticket: string
): Promise<{ user: User; bind: SocketBind } | null> {
  const raw = (await app.redis.getdel(`sse:ticket:${ticket}`).catch(() => null)) as string | null
  const minted = raw ? parseWsTokenValue(raw) : null
  if (!minted?.userId || !minted.bind) return null
  if (await checkBind(app.redis, minted.userId, minted.bind)) return null
  let row = (await db('nivaro_users').where({ id: minted.userId }).first()) as User | undefined
  if (row && minted.bind.kind === 'apikey')
    row = (await userWithApiKey(row, minted.bind.id)) ?? undefined
  return row ? { user: row, bind: minted.bind } : null
}

/** The sign-in as it stands now: the account row, narrowed by the API key when it is one. */
async function freshIdentity(userId: string, bind: SocketBind): Promise<User | null> {
  const row = (await db('nivaro_users').where({ id: userId, status: 'active' }).first()) as
    | User
    | undefined
  if (!row) return null
  if (bind.kind === 'apikey') return userWithApiKey(row, bind.id)
  return row
}

function cursorOf(raw: unknown): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export async function viewStreamRoutes(app: FastifyInstance) {
  app.get('/:id/stream', async (req, reply) => {
    const q = req.query as { ticket?: string; values?: string; last_event_id?: string }
    const viewId = Number((req.params as { id: string }).id)

    let bind: SocketBind | null = null
    if (q.ticket && /^[a-f0-9-]{36}$/i.test(q.ticket) && !req.headers.authorization) {
      const redeemed = await redeemTicket(app, q.ticket)
      if (redeemed) {
        req.user = redeemed.user as never
        bind = redeemed.bind
      }
    }
    if (!req.user) {
      await authenticate(req, reply)
      bind = bindFromRequest(req)
    }
    if (!req.user || !bind) return reply.code(401).send({ error: 'Unauthorized' })
    const userId = String(req.user.id)
    // An API-key request already carries the key's narrowing; re-read it the same way the
    // heartbeat does so the stream starts from exactly what it will be re-checked against.
    let user: User | null = await freshIdentity(userId, bind)
    if (!user) return reply.code(401).send({ error: 'Unauthorized' })

    const opened = await openView(user, viewId)
    if (!opened.ok) return reply.code(opened.status).send({ error: opened.error })
    let view: SavedViewRow = opened.view
    let conditions: ViewCondition[] = opened.conditions

    const cursor = cursorOf(req.headers['last-event-id'] ?? q.last_event_id)
    const tenant = currentTenantKey()
    const room = tenantScopedRoom(`collection:${view.collection}`)
    const snapKey = snapshotKey(tenant, view.id, `${userId}|${JSON.stringify(bind)}`)

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    raw.write('retry: 5000\n\n')

    let closed = false
    const write = (text: string) => {
      if (closed) return
      try {
        raw.write(text)
      } catch {
        cleanup()
      }
    }
    const session = new ViewStreamSession({
      user: () => user as User,
      view,
      conditions: () => conditions,
      includeValues: q.values === '1' || q.values === 'true',
      write: (f) => write(frameText(f))
    })

    // Changes arrive in the WRITER's context (another request, or the Redis stream reader);
    // the matching reads must run in this request's (cloud: this tenant's database).
    const inRequestContext = AsyncLocalStorage.snapshot()
    // Listen before the baseline and the replay, so nothing lands in between. Live changes
    // wait in `early` until the replay is queued, so the partner gets them in order; the
    // session drops a sequence it has already handled.
    let early: Parameters<typeof session.push>[0][] | null = []
    let earlyOverflow = false
    const unlisten = onJournalEntry((entry) => {
      const change = collectionChangeOf(entry)
      if (!change || change.tenant !== tenant || change.collection !== view.collection) return
      if (early) {
        if (early.length < 5_000) early.push(change)
        else earlyOverflow = true
        return
      }
      inRequestContext(() => session.push(change))
    })

    async function persistSnapshot(): Promise<void> {
      if (!session.membershipChanged) return
      session.membershipChanged = false
      await saveSnapshot(app.redis, snapKey, session.membership ? [...session.membership] : null)
    }

    async function closeWith(event: string, reason: string): Promise<void> {
      write(frameText({ id: null, event, data: { reason } }))
      cleanup()
    }

    const heartbeat = setInterval(() => {
      if (closed) return
      void (async () => {
        try {
          const ended = await checkBind(app.redis, userId, bind)
          if (ended) return closeWith('session.ended', ended)
          const next = await freshIdentity(userId, bind as SocketBind)
          if (!next) return closeWith('session.ended', 'signed_out')
          const again = await openView(next, view.id)
          if (!again.ok)
            return closeWith('view.closed', again.status === 404 ? 'not_found' : 'forbidden')
          user = next
          view = again.view
          conditions = again.conditions
          await persistSnapshot()
          write(': hb\n\n')
        } catch {
          write(': hb\n\n') // a failed check never ends a stream; the next heartbeat asks again
        }
      })()
    }, HEARTBEAT_MS)
    heartbeat.unref()

    function cleanup(): void {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      unlisten()
      session.close()
      void persistSnapshot()
      try {
        raw.end()
      } catch {
        /* already gone */
      }
    }
    req.raw.on('close', cleanup)
    req.raw.on('error', cleanup)

    try {
      const previous = cursor != null ? await loadSnapshot(app.redis, snapKey) : []
      await session.init(previous)
      session.membershipChanged = true
      let resumed = false
      if (cursor != null) {
        const replay = await replaySince(cursor, new Set([room]))
        if (replay.full)
          write(frameText({ id: null, event: 'reset', data: { reason: 'cursor_expired' } }))
        else {
          resumed = true
          for (const e of replay.events) {
            const change = collectionChangeOf(e)
            if (change) session.push(change)
          }
        }
      }
      if (earlyOverflow)
        write(frameText({ id: null, event: 'reset', data: { reason: 'overflow' } }))
      else for (const change of early ?? []) session.push(change)
      early = null
      // The ready frame carries the current sequence, so a partner that hears nothing before
      // it drops still has a cursor to resume from.
      const seq = await currentSeq().catch(() => null)
      write(
        frameText({
          id: cursor == null && seq ? seq : null,
          event: 'ready',
          data: { view: view.id, collection: view.collection, resumed }
        })
      )
      await session.start()
    } catch {
      await closeWith('reset', 'unavailable')
    }
  })
}
