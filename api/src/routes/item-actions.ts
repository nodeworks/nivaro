import type { FastifyInstance } from 'fastify'
import { itemActionRegistry } from '../extensions/item-actions.js'
import { describeDbRefusal, messageWithoutSql } from '../lib/db-refusal.js'
import { authenticate, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { callAsCallerFor } from '../services/caller-inject.js'

export async function itemActionsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // List actions available for a collection
  app.get('/item-actions/registered', { preHandler: [requireAuth] }, async (req) => {
    const q = req.query as Record<string, string>
    const collection = q.collection
    const item = q.item
    const actions = itemActionRegistry.list(collection)
    // With ?item=, per-record applicability gates run so the client only
    // renders buttons that can actually do something on THIS record.
    const kept = item
      ? (
          await Promise.all(
            actions.map(async (a) => {
              if (!collection) return a
              // Declared requirement first: an addendum-creating action hides
              // when the caller couldn't create an addendum here at all.
              if (a.requires_addendum_create) {
                try {
                  const { canCreateAddendum } = await import('../services/addendum-approve.js')
                  const gate = await canCreateAddendum(collection, item, {
                    roleId: (req.user?.role as string | null) ?? null,
                    isAdmin: !!req.isAdmin
                  })
                  if (!gate.ok) return null
                } catch {
                  /* gate error must not hide a working action */
                }
              }
              if (!a.applicable) return a
              const ok = await a.applicable({ collection, itemId: item }).catch(() => true) // broken check must not hide a working action
              return ok ? a : null
            })
          )
        ).filter((a): a is (typeof actions)[number] => a !== null)
      : actions
    return {
      data: kept.map(({ execute: _x, applicable: _a, preflight, choose, ...rest }) => ({
        ...rest,
        // #616 — the form asks /preflight only for actions that can answer.
        has_preflight: typeof preflight === 'function',
        // The client asks /choices when pressed; the options are per record.
        ...(choose
          ? { choose: { key: choose.key, label: choose.label, body: choose.body ?? null } }
          : {})
      }))
    }
  })

  // What a `choose` action offers on THIS record (e.g. which file to send).
  app.get<{ Params: { id: string }; Querystring: { collection?: string; item?: string } }>(
    '/item-actions/:id/choices',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const action = itemActionRegistry.get(req.params.id)
      if (!action) return reply.status(404).send({ error: 'Item action not found' })
      const collection = String(req.query.collection ?? '')
      const item = String(req.query.item ?? '')
      if (!collection || !item)
        return reply.status(400).send({ error: 'collection and item are required' })
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection))
        return reply.status(400).send({ error: 'Not a valid collection' })
      // Options name the record's contents (file names) — bind the check to
      // the action's own collections and to THIS record being visible, so a
      // caller can't point the action at a record they cannot read.
      if (action.collections && !action.collections.includes(collection))
        return reply.status(404).send({ error: 'Item action not found' })
      const { can } = await import('../services/permissions.js')
      if (!(await can(req.user!, 'read', collection)))
        return reply.status(403).send({ error: 'Forbidden' })
      const { readOne } = await import('../services/items.js')
      const row = await readOne(req.user!, collection, item, undefined, ['id']).catch(() => null)
      if (!row) return reply.status(404).send({ error: 'Not found' })
      if (!action.choose) return { data: [] }
      if (action.applicable) {
        const ok = await action.applicable({ collection, itemId: item }).catch(() => true)
        if (!ok) return { data: [] }
      }
      try {
        const raw = await action.choose.options({ collection, itemId: item, userId: req.user?.id })
        return {
          data: (Array.isArray(raw) ? raw : [])
            .filter((o) => o && o.value != null && o.label != null)
            .slice(0, 200)
            .map((o) => ({
              value: String(o.value),
              label: String(o.label).slice(0, 300),
              ...(o.hint != null ? { hint: String(o.hint).slice(0, 300) } : {})
            }))
        }
      } catch (err) {
        // Extension errors can be raw SQL text — log it, never send it.
        req.log.error(
          { err, action: req.params.id, collection, item },
          'item action choices failed'
        )
        return reply.status(500).send({ error: 'Could not load the options' })
      }
    }
  )

  // #616 — what would stop this action on THIS record, before anyone presses
  // it. Read-only: the extension's own pre-validations, nothing sent.
  app.get<{ Params: { id: string }; Querystring: { collection?: string; item?: string } }>(
    '/item-actions/:id/preflight',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const action = itemActionRegistry.get(req.params.id)
      if (!action) return reply.status(404).send({ error: 'Item action not found' })
      const collection = String(req.query.collection ?? '')
      const item = String(req.query.item ?? '')
      if (!collection || !item)
        return reply.status(400).send({ error: 'collection and item are required' })
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection))
        return reply.status(400).send({ error: 'Not a valid collection' })
      if (action.collections && !action.collections.includes(collection))
        return reply.status(404).send({ error: 'Item action not found' })
      const { can } = await import('../services/permissions.js')
      if (!(await can(req.user!, 'read', collection)))
        return reply.status(403).send({ error: 'Forbidden' })
      // The issues name the record's lines and fields — only for a record
      // the caller can see.
      const { readOne } = await import('../services/items.js')
      const row = await readOne(req.user!, collection, item, undefined, ['id']).catch(() => null)
      if (!row) return reply.status(404).send({ error: 'Not found' })
      if (typeof action.preflight !== 'function')
        return { data: { ready: true, supported: false, issues: [] } }
      try {
        const raw = await action.preflight({ collection, itemId: item, userId: req.user?.id })
        const issues = (Array.isArray(raw) ? raw : [])
          .filter((i) => i && typeof i.message === 'string' && i.message.trim() !== '')
          .slice(0, 50)
          .map((i) => ({
            message: String(i.message).slice(0, 300),
            severity: i.severity === 'warn' ? 'warn' : 'block',
            field: typeof i.field === 'string' ? i.field : undefined,
            collection: typeof i.collection === 'string' ? i.collection : undefined,
            fk_field: typeof i.fk_field === 'string' ? i.fk_field : undefined,
            rows: Array.isArray(i.rows)
              ? i.rows.slice(0, 200).map((r) => ({
                  id: String(r.id),
                  label: r.label != null ? String(r.label) : `#${r.id}`
                }))
              : undefined
          }))
        return {
          data: {
            ready: !issues.some((i) => i.severity === 'block'),
            supported: true,
            issues
          }
        }
      } catch (err) {
        // Never "ready" on a check that failed — and never driver text.
        const message = err instanceof Error ? err.message.trim() : ''
        if (!message || looksLikeDriverError(err, message))
          req.log.error(
            { err, action: req.params.id, collection, item },
            'item action preflight failed'
          )
        return {
          data: {
            ready: false,
            supported: true,
            error:
              message && !looksLikeDriverError(err, message) ? message : 'Pre-flight check failed',
            issues: []
          }
        }
      }
    }
  )

  // Execute a registered item action. The action's mutation lives in
  // extension code, so the gates the record form applies are enforced here:
  // the action serves this collection, the caller may read AND update THIS
  // record, and the action's own applicability check passes.
  app.post<{
    Params: { id: string }
    Body: { collection: string; itemId: string | number; payload?: Record<string, unknown> }
  }>('/item-actions/:id/execute', { preHandler: [requireAuth] }, async (req, reply) => {
    const action = itemActionRegistry.get(req.params.id)
    if (!action) return reply.status(404).send({ error: 'Item action not found' })

    const { collection, itemId, payload } = req.body ?? ({} as typeof req.body)
    if (!collection || itemId == null || String(itemId).trim() === '') {
      return reply.status(400).send({ error: 'collection and itemId are required' })
    }
    if (typeof collection !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(collection))
      return reply.status(400).send({ error: 'Not a valid collection' })
    if (action.collections && !action.collections.includes(collection))
      return reply.status(404).send({ error: 'Item action not found' })

    const user = req.user!
    const { can } = await import('../services/permissions.js')
    if (!(await can(user, 'read', collection)) || !(await can(user, 'update', collection)))
      return reply.status(403).send({ error: 'Forbidden' })
    const workspaceId = req.workspaceId ?? undefined
    const { canUpdateItem, readOne } = await import('../services/items.js')
    // readOne answers null (or throws) for a record the caller can't see —
    // asked first, so a hidden record reads as missing, never as forbidden.
    const row = await readOne(user, collection, itemId, workspaceId, ['id']).catch(() => null)
    if (!row) return reply.status(404).send({ error: 'Not found' })
    if (!(await canUpdateItem(user, collection, itemId, workspaceId)))
      return reply.status(403).send({ error: 'You cannot change this record' })
    // The action writes through extension code with no request, which the
    // approval edit lock exempts as an engine write — so judge the caller here.
    {
      const { assertNotEditLocked, EditLockedError, EDIT_LOCKED } = await import(
        '../services/edit-lock.js'
      )
      try {
        await assertNotEditLocked(user, collection, { ids: [itemId] }, req)
      } catch (e) {
        const message =
          e instanceof EditLockedError
            ? e.message
            : 'Could not confirm you may change this record while it waits.'
        return reply.status(403).send({ error: message, code: EDIT_LOCKED })
      }
    }

    if (action.requires_addendum_create) {
      const { canCreateAddendum } = await import('../services/addendum-approve.js')
      const gate = await canCreateAddendum(collection, itemId, {
        roleId: (user.role as string | null) ?? null,
        isAdmin: !!req.isAdmin
      })
      if (!gate.ok) return reply.status(403).send({ error: gate.reason ?? 'Addendums unavailable' })
    }
    if (action.applicable) {
      // Same rule as the button list: a broken check must not block a
      // working action — only a clear "no" refuses.
      const ok = await action.applicable({ collection, itemId: String(itemId) }).catch(() => true)
      if (!ok)
        return reply
          .status(409)
          .send({ error: `${action.label} is not available on this record right now` })
    }

    try {
      const result = await action.execute({
        collection,
        itemId,
        payload,
        userId: user.id,
        callAsCaller: callAsCallerFor(req)
      })
      // The mutation itself lives in extension code — log the invocation.
      await logActivity({
        action: 'item-action-execute',
        user: user.id,
        collection,
        item: String(itemId),
        comment: req.params.id,
        req
      })
      return { data: result }
    } catch (err) {
      const failure = executeFailure(err)
      if (failure.status >= 500)
        req.log.error({ err, action: req.params.id, collection, itemId }, 'item action failed')
      return reply
        .status(failure.status)
        .send({ error: failure.error, ...(failure.code ? { code: failure.code } : {}) })
    }
  })
}

/**
 * What a failed item action answers. An extension marks a refusal that is the
 * caller's doing (a missing field, a record in the wrong state) with a 4xx
 * `statusCode` and a sentence written for people — that is passed on. A
 * database refusal of the caller's data becomes its 4xx. Driver text (SQL,
 * column names, conversion errors) never reaches the browser: it is logged and
 * the answer is a plain 500. Any other extension error keeps its own message.
 * Exported for the unit tests.
 */
export function executeFailure(err: unknown): { status: number; error: string; code?: string } {
  const refusal = describeDbRefusal(err)
  if (refusal) return { status: refusal.status, error: refusal.message, code: refusal.code }
  const e = (err ?? {}) as { statusCode?: unknown; status?: unknown; code?: unknown }
  const status = Number(e.statusCode ?? e.status)
  const message = err instanceof Error ? err.message.trim() : ''
  if (looksLikeDriverError(err, message))
    return { status: 500, error: 'The action failed. The details are in the server log.' }
  if (Number.isInteger(status) && status >= 400 && status < 500)
    return {
      status,
      error: message || 'The action was refused',
      ...(typeof e.code === 'string' ? { code: e.code } : {})
    }
  return { status: 500, error: message || 'The action failed' }
}

const DRIVER_TEXT =
  /Invalid (column|object) name|Incorrect syntax near|Conversion failed when converting|Validation failed for parameter|Must declare the scalar variable|The multi-part identifier|Arithmetic overflow|deadlocked on lock|Timeout acquiring a connection|Cannot insert the value NULL|There is already an object named/i

function looksLikeDriverError(err: unknown, message: string): boolean {
  const e = (err ?? {}) as { name?: unknown; number?: unknown; errors?: unknown }
  if (typeof e.number === 'number') return true // tedious RequestError carries the SQL error number
  if (e.name === 'RequestError' || e.name === 'ConnectionError' || e.name === 'KnexTimeoutError')
    return true
  if (Array.isArray(e.errors)) return true // knex/mssql AggregateError
  if (DRIVER_TEXT.test(message)) return true
  return message !== '' && messageWithoutSql(err) !== message
}
