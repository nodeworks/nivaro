import type { FastifyInstance } from 'fastify'
import * as XLSX from 'xlsx'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  branchConversation,
  type ConversationRow,
  conversationAccess,
  deleteMessage,
  exportFileName,
  getConversation,
  listConversations,
  listMessages,
  messagesForViewer,
  namesFor,
  parseJsonArray,
  REPLAYABLE_TOOLS,
  rowsFromToolResult,
  sameUserId,
  toCsv
} from '../services/ai-conversations.js'
import type { User } from '../types.js'

/**
 * Ask AI conversations (#1833 history, #1809 sharing, #1883 branches, #1851
 * post to chat, #1841 export). Every route is the caller's own: a
 * conversation is reachable by its owner, the people it is shared with and
 * readers of a room it was posted to — never by role alone (admins included).
 * Answers are filtered per viewer by the sharing rule in
 * services/ai-conversations.ts. Asking (and storing turns) happens in
 * POST /ai/chat with `conversation_id`.
 */

const notFound = { error: 'Conversation not found' }

export function conversationLink(id: string): string {
  return `${adminBaseUrl() ?? ''}/ask?conversation=${encodeURIComponent(id)}`
}

async function load(
  user: User,
  id: string
): Promise<{ conv: ConversationRow; access: 'owner' | 'shared' | 'room' } | null> {
  const conv = await getConversation(id)
  if (!conv) return null
  const access = await conversationAccess(user, conv)
  return access ? { conv, access } : null
}

export async function aiConversationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // ── List — mine and shared with me, newest first, pinned on top ──────────
  app.get('/', async (req) => {
    const q = req.query as { q?: string; pinned?: string; limit?: string }
    return {
      data: await listConversations(req.user!, {
        q: q.q,
        pinned: q.pinned === '1' || q.pinned === 'true',
        limit: Number(q.limit) || undefined
      })
    }
  })

  // ── One conversation as the caller may read it ───────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const found = await load(req.user!, req.params.id)
    if (!found) return reply.code(404).send(notFound)
    const { conv, access } = found
    const messages = await messagesForViewer(req.user!, await listMessages(conv.id))
    let shares: Array<Record<string, unknown>> = []
    if (access === 'owner') {
      const rows = (await db('nivaro_ai_conversation_shares')
        .where({ conversation_id: conv.id })
        .orderBy('id', 'asc')
        .select('id', 'user', 'room', 'created_at')) as Array<Record<string, unknown>>
      const names = await namesFor(rows.map((r) => String(r.user ?? '')))
      shares = rows.map((r) => ({
        id: r.id,
        user: r.user
          ? { id: String(r.user), name: names.get(String(r.user).toUpperCase()) ?? 'Someone' }
          : null,
        room: r.room ?? null,
        created_at: new Date(r.created_at as string).toISOString()
      }))
    }
    let pinned = !!conv.pinned
    if (access !== 'owner') {
      const mine = (await db('nivaro_ai_conversation_shares')
        .where({ conversation_id: conv.id, user: req.user!.id })
        .first('pinned')) as { pinned?: unknown } | undefined
      pinned = !!mine?.pinned
    }
    const owner = await namesFor([conv.owner])
    // #1883 — the branches cut from this thread (the caller's own; another
    // person's branch is their conversation) and the thread this one came
    // from, when the caller can still reach it.
    const branches = (
      (await db('nivaro_ai_conversations')
        .where({ parent_id: conv.id, owner: req.user!.id })
        .orderBy('created_at', 'asc')
        .select('id', 'title', 'branch_from', 'created_at')) as Array<Record<string, unknown>>
    ).map((b) => ({
      id: String(b.id),
      title: String(b.title),
      branch_from: b.branch_from != null ? String(b.branch_from) : null,
      created_at: new Date(b.created_at as string).toISOString()
    }))
    let parent: { id: string; title: string } | null = null
    if (conv.parent_id) {
      const p = await load(req.user!, conv.parent_id)
      if (p) parent = { id: p.conv.id, title: p.conv.title }
    }
    return {
      data: {
        conversation: {
          id: conv.id,
          title: conv.title,
          pinned,
          parent_id: conv.parent_id,
          branch_from: conv.branch_from != null ? String(conv.branch_from) : null,
          created_at: new Date(conv.created_at).toISOString(),
          updated_at: new Date(conv.updated_at).toISOString(),
          owner: { id: conv.owner, name: owner.get(conv.owner.toUpperCase()) ?? 'Someone' },
          access,
          link: conversationLink(conv.id)
        },
        messages,
        shares,
        branches,
        parent
      }
    }
  })

  // ── Rename / pin ──────────────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const found = await load(req.user!, req.params.id)
    if (!found) return reply.code(404).send(notFound)
    const body = (req.body ?? {}) as { title?: unknown; pinned?: unknown }
    const { conv, access } = found
    if ('title' in body) {
      if (access !== 'owner') return reply.code(403).send({ error: 'Only the owner renames it' })
      const title = String(body.title ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
      if (!title) return reply.code(400).send({ error: 'title is required' })
      await db('nivaro_ai_conversations').where({ id: conv.id }).update({ title })
    }
    if ('pinned' in body) {
      const pinned = body.pinned === true
      if (access === 'owner') {
        await db('nivaro_ai_conversations').where({ id: conv.id }).update({ pinned })
      } else if (access === 'shared') {
        await db('nivaro_ai_conversation_shares')
          .where({ conversation_id: conv.id, user: req.user!.id })
          .update({ pinned })
      } else {
        return reply.code(400).send({ error: 'Pin it after it is shared with you' })
      }
    }
    return { data: { ok: true } }
  })

  // ── Delete (owner) / leave (shared) ──────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const found = await load(req.user!, req.params.id)
    if (!found) return reply.code(404).send(notFound)
    if (found.access === 'owner') {
      await db('nivaro_ai_conversations').where({ id: found.conv.id }).del()
      return { data: { deleted: true } }
    }
    if (found.access === 'shared') {
      await db('nivaro_ai_conversation_shares')
        .where({ conversation_id: found.conv.id, user: req.user!.id })
        .del()
      return { data: { left: true } }
    }
    return reply.code(400).send({ error: 'A conversation posted to a room cannot be removed here' })
  })

  // ── Share with people (#1809) — the owner decides ────────────────────────
  app.post<{ Params: { id: string } }>('/:id/shares', async (req, reply) => {
    const found = await load(req.user!, req.params.id)
    if (!found) return reply.code(404).send(notFound)
    if (found.access !== 'owner') return reply.code(403).send({ error: 'Only the owner shares it' })
    const raw = (req.body as { user_ids?: unknown })?.user_ids
    const ids = (Array.isArray(raw) ? raw : [])
      .map(String)
      .filter((i) => /^[0-9a-f-]{36}$/i.test(i) && !sameUserId(i, req.user!.id))
      .slice(0, 50)
    if (!ids.length) return reply.code(400).send({ error: 'user_ids is required' })
    const people = (await db('nivaro_users')
      .whereIn('id', ids)
      .where({ status: 'active' })
      .where((w) => w.where('is_redacted', false).orWhereNull('is_redacted'))
      .select('id')) as Array<{ id: string }>
    const existing = new Set(
      (
        (await db('nivaro_ai_conversation_shares')
          .where({ conversation_id: found.conv.id })
          .whereNotNull('user')
          .pluck('user')) as string[]
      ).map((u) => u.toUpperCase())
    )
    const added: string[] = []
    for (const p of people) {
      if (existing.has(p.id.toUpperCase())) continue
      await db('nivaro_ai_conversation_shares').insert({
        conversation_id: found.conv.id,
        user: p.id,
        shared_by: req.user!.id,
        created_at: new Date()
      })
      added.push(p.id)
    }
    if (added.length) {
      await logActivity({
        action: 'ai-conversation-share',
        user: req.user!.id,
        collection: 'nivaro_ai_conversations',
        item: found.conv.id,
        comment: `shared with ${added.length} ${added.length === 1 ? 'person' : 'people'}`,
        req
      })
      const { notifyUser } = await import('../services/notification-channels.js')
      const me = await namesFor([String(req.user!.id)])
      const who = me.get(String(req.user!.id).toUpperCase()) ?? 'Someone'
      for (const uid of added) {
        void notifyUser(app, uid, {
          subject: `${who} shared an Ask AI conversation with you`,
          message: `“${found.conv.title}” — answers you open are checked against your own access.`,
          category: 'system',
          target: { kind: 'external', url: conversationLink(found.conv.id) },
          why: `${who} shared it with you.`
        }).catch(() => {})
      }
    }
    return { data: { added: added.length } }
  })

  app.delete<{ Params: { id: string; shareId: string } }>(
    '/:id/shares/:shareId',
    async (req, reply) => {
      const found = await load(req.user!, req.params.id)
      if (!found) return reply.code(404).send(notFound)
      if (found.access !== 'owner')
        return reply.code(403).send({ error: 'Only the owner unshares' })
      const n = await db('nivaro_ai_conversation_shares')
        .where({ conversation_id: found.conv.id, id: Number(req.params.shareId) || 0 })
        .del()
      return { data: { removed: n } }
    }
  )

  // ── Branch from an edited question (#1883) ───────────────────────────────
  app.post<{ Params: { id: string } }>('/:id/branch', async (req, reply) => {
    const found = await load(req.user!, req.params.id)
    if (!found) return reply.code(404).send(notFound)
    const body = (req.body ?? {}) as { message_id?: unknown; question?: unknown }
    const question = String(body.question ?? '').trim()
    if (!question) return reply.code(400).send({ error: 'question is required' })
    const branch = await branchConversation(
      req.user!,
      found.conv,
      String(body.message_id ?? ''),
      question
    )
    if (!branch) return reply.code(400).send({ error: 'message_id must be a question in it' })
    return { data: { id: branch.id, title: branch.title, parent_id: branch.parent_id } }
  })

  // ── Post to a chat room as a card (#1851) ────────────────────────────────
  app.post<{ Params: { id: string } }>('/:id/post', async (req, reply) => {
    const found = await load(req.user!, req.params.id)
    if (!found) return reply.code(404).send(notFound)
    const body = (req.body ?? {}) as { room?: unknown; note?: unknown }
    const room = String(body.room ?? '').trim()
    if (!room || room.length > 200) return reply.code(400).send({ error: 'room is required' })
    const { canSeeRoom } = await import('../services/chat.js')
    if (!(await canSeeRoom(req.user!, room))) {
      return reply.code(403).send({ error: 'You cannot post to that room' })
    }
    const existing = await db('nivaro_ai_conversation_shares')
      .where({ conversation_id: found.conv.id, room })
      .first('id')
    if (!existing) {
      await db('nivaro_ai_conversation_shares').insert({
        conversation_id: found.conv.id,
        room,
        shared_by: req.user!.id,
        created_at: new Date()
      })
    }
    // The message carries the QUESTION and the link, never answer text: the
    // card under it is built per reader (GET /chat/app-card), and a reader
    // only sees an answer the sharing rule lets them read.
    const note = String(body.note ?? '')
      .trim()
      .slice(0, 1000)
    const message = `${note ? `${note}\n\n` : ''}Ask AI: “${found.conv.title}”\n${conversationLink(found.conv.id)}`
    const { postChatMessage } = await import('../services/chat-send.js')
    try {
      const row = await postChatMessage(
        app,
        { user: req.user!, isAdmin: !!req.isAdmin },
        { room, message }
      )
      await logActivity({
        action: 'ai-conversation-post',
        user: req.user!.id,
        collection: 'nivaro_ai_conversations',
        item: found.conv.id,
        comment: `posted to ${room}`,
        req
      })
      return { data: { message_id: row.id } }
    } catch (err) {
      const e = err as { statusCode?: number; message?: string; code?: string }
      if (e.statusCode && e.statusCode < 500)
        return reply.code(e.statusCode).send({ error: e.message, code: e.code })
      throw err
    }
  })

  // ── Export the rows behind an answer (#1841) ─────────────────────────────
  // Re-runs the answer's data call AS THE CALLER — never the answer's text —
  // so the file holds exactly what they may read today.
  app.get<{ Params: { id: string; mid: string } }>(
    '/:id/messages/:mid/export',
    async (req, reply) => {
      const found = await load(req.user!, req.params.id)
      if (!found) return reply.code(404).send(notFound)
      const q = req.query as { format?: string; step?: string }
      const format = q.format === 'xlsx' ? 'xlsx' : 'csv'
      const rows = await listMessages(found.conv.id)
      const idx = rows.findIndex((r) => String(r.id) === req.params.mid)
      const msg = rows[idx]
      if (msg?.role !== 'assistant') return reply.code(404).send({ error: 'Answer not found' })
      const trace = parseJsonArray<{
        tool: string
        input: Record<string, unknown>
        summary: string
      }>(msg.trace)
      const exportable = trace
        .map((t, i) => ({ t, i }))
        .filter(
          ({ t }) =>
            t &&
            REPLAYABLE_TOOLS.has(t.tool) &&
            t.tool !== 'list_collections' &&
            !String(t.summary ?? '').startsWith('error:')
        )
      const step =
        q.step != null && q.step !== ''
          ? exportable.find(({ i }) => i === Number(q.step))
          : exportable[exportable.length - 1]
      if (!step) return reply.code(400).send({ error: 'This answer has no rows to export' })
      const { executeChatTool } = await import('../services/ai-chat.js')
      let data: Array<Record<string, unknown>>
      try {
        const { result } = await executeChatTool(req.user!, step.t.tool, step.t.input ?? {})
        data = rowsFromToolResult(result)
      } catch (err) {
        return reply
          .code(422)
          .send({ error: err instanceof Error ? err.message : 'The query could not be re-run' })
      }
      const question = [...rows.slice(0, idx)].reverse().find((r) => r.role === 'user')?.content
      const name = exportFileName(question ?? found.conv.title)
      await logActivity({
        action: 'ai-answer-export',
        user: req.user!.id,
        collection: 'nivaro_ai_conversations',
        item: found.conv.id,
        comment: `${data.length} row(s) as ${format} (${step.t.tool})`,
        req
      })
      if (format === 'xlsx') {
        const wb = XLSX.utils.book_new()
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Answer')
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
        return reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          )
          .header('Content-Disposition', `attachment; filename="${name}.xlsx"`)
          .send(buf)
      }
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${name}.csv"`)
        .send(`﻿${toCsv(data)}`)
    }
  )

  // ── Remove one exchange the owner regrets asking ─────────────────────────
  app.delete<{ Params: { id: string; mid: string } }>('/:id/messages/:mid', async (req, reply) => {
    const found = await load(req.user!, req.params.id)
    if (!found) return reply.code(404).send(notFound)
    const rows = await listMessages(found.conv.id)
    const msg = rows.find((r) => String(r.id) === req.params.mid)
    if (!msg) return reply.code(404).send({ error: 'Message not found' })
    if (found.access !== 'owner' && !sameUserId(msg.author, req.user!.id)) {
      return reply.code(403).send({ error: 'Only your own messages' })
    }
    await deleteMessage(found.conv.id, String(msg.id))
    return { data: { deleted: true } }
  })
}
