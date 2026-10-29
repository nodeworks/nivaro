import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { mcpClientNameOf, mcpConnOf } from './mcp-calls.js'

/**
 * ask_human (#3220): an agent asks a person a question and reads the answer back.
 *
 * The agent is an MCP connection acting as its person (OAuth grant, API key or token). It
 * posts a question — free text, or a short list of choices — to someone's inbox: a
 * notification (category mentions) that opens My Work on the question, where the person
 * answers. The agent reads the answer by id (`GET /api/agent-questions/:id?wait=25` holds the
 * request up to 25 s for it), from my_work's `answers` list, or — in a live MCP session that
 * subscribed to `nivaro://question/<id>` — from a resources/updated notice the moment it lands.
 *
 * Only the person asked can answer, and only from a signed-in browser session: an agent
 * (an MCP call, an API key, an OAuth token, a static token, a View-as session) can never
 * answer a question, its own or anyone's. Questions expire (default 24 h, at most 7 days).
 */

export const MAX_CHOICES = 10
export const MAX_QUESTION = 4000
export const MAX_ANSWER = 4000
export const DEFAULT_EXPIRY_MIN = 24 * 60
export const MAX_EXPIRY_MIN = 7 * 24 * 60
export const MIN_EXPIRY_MIN = 5
/** Open questions one connection may have at once, and to one person. */
export const MAX_OPEN_PER_CONN = 25
export const MAX_OPEN_PER_RECIPIENT = 5
export const MAX_WAIT_S = 25

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLLECTION_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export interface QuestionRow {
  id: string
  asker_conn: string
  asker_name: string | null
  asker: string
  recipient: string
  question: string
  choices: string | null
  allow_text: boolean | number
  collection: string | null
  item: string | null
  status: string
  answer: string | null
  answer_choice: string | null
  answered_by: string | null
  answered_at: Date | string | null
  answer_seen_at: Date | string | null
  expires_at: Date | string
  created_at: Date | string | null
  updated_at: Date | string | null
}

export class QuestionError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message)
  }
}

export async function questionsReady(): Promise<boolean> {
  return hasColumn('nivaro_agent_questions', 'id').catch(() => false)
}

const same = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase()

export function parseChoices(raw: unknown): string[] {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return []
    }
  }
  return Array.isArray(v) ? v.map((c) => String(c)).filter(Boolean) : []
}

/** Open but past its expiry reads as expired, before the sweep has marked it. */
export function effectiveStatus(row: Pick<QuestionRow, 'status' | 'expires_at'>, now = Date.now()) {
  if (row.status === 'open' && new Date(row.expires_at).getTime() <= now) return 'expired'
  return row.status
}

/**
 * Who may an agent's request act as, for answering? Only a person at the keyboard: a browser
 * session that is not View-as, and not an in-process MCP call.
 */
export function isHumanSession(req: FastifyRequest): boolean {
  return req.authMethod === 'session' && !req.mcpInner
}

export interface AskInput {
  to?: unknown
  question?: unknown
  choices?: unknown
  allow_text?: unknown
  expires_in_minutes?: unknown
  collection?: unknown
  item?: unknown
}

export function normalizeAsk(input: AskInput, callerId: string) {
  const question = String(input.question ?? '').trim()
  if (!question) throw new QuestionError(400, 'question is required')
  if (question.length > MAX_QUESTION)
    throw new QuestionError(400, `A question is at most ${MAX_QUESTION} characters`)
  const raw = input.to == null || input.to === '' || input.to === 'me' ? callerId : input.to
  const to = String(raw)
  if (!UUID_RE.test(to)) throw new QuestionError(400, 'to must be a user id (or "me")')
  let choices: string[] = []
  if (input.choices != null) {
    if (!Array.isArray(input.choices)) throw new QuestionError(400, 'choices must be a list')
    choices = [...new Set(input.choices.map((c) => String(c ?? '').trim()).filter(Boolean))]
    if (choices.length > MAX_CHOICES) throw new QuestionError(400, `At most ${MAX_CHOICES} choices`)
    if (choices.some((c) => c.length > 200))
      throw new QuestionError(400, 'A choice is at most 200 characters')
  }
  // Free text is allowed unless choices were given and allow_text is not set.
  const allowText = choices.length === 0 ? true : input.allow_text === true
  const minutes =
    input.expires_in_minutes == null ? DEFAULT_EXPIRY_MIN : Number(input.expires_in_minutes)
  if (!Number.isFinite(minutes) || minutes < MIN_EXPIRY_MIN || minutes > MAX_EXPIRY_MIN)
    throw new QuestionError(
      400,
      `expires_in_minutes must be ${MIN_EXPIRY_MIN} to ${MAX_EXPIRY_MIN} (7 days)`
    )
  let collection: string | null = null
  let item: string | null = null
  if (input.collection != null && input.collection !== '') {
    collection = String(input.collection)
    if (!COLLECTION_RE.test(collection) || /^(nivaro|directus)_/i.test(collection))
      throw new QuestionError(400, 'collection is not valid')
    if (input.item == null || input.item === '')
      throw new QuestionError(400, 'Pass item with collection')
    item = String(input.item).slice(0, 255)
  }
  return { to, question, choices, allowText, minutes: Math.round(minutes), collection, item }
}

function personName(u?: {
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}) {
  if (!u) return null
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null
}

async function names(ids: string[]): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter(Boolean).map((i) => i.toLowerCase()))]
  if (!uniq.length) return new Map()
  const rows = (await db('nivaro_users')
    .whereIn('id', uniq)
    .select('id', 'first_name', 'last_name', 'email')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), personName(r)]))
}

/** The question as one of its parties reads it. The connection key is the asker's only. */
export async function questionView(
  row: QuestionRow,
  viewer: { id: string; isAsker: boolean },
  nameMap?: Map<string, string | null>
) {
  const n = nameMap ?? (await names([row.asker, row.recipient]))
  return {
    id: row.id,
    status: effectiveStatus(row),
    question: row.question,
    choices: parseChoices(row.choices),
    allow_text: !!row.allow_text,
    collection: row.collection,
    item: row.item,
    asked_by: row.asker_name ?? 'An assistant',
    asked_for: row.asker,
    asked_for_name: n.get(String(row.asker).toLowerCase()) ?? null,
    recipient: row.recipient,
    recipient_name: n.get(String(row.recipient).toLowerCase()) ?? null,
    answer: row.answer,
    answer_choice: row.answer_choice,
    answered_at: row.answered_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    ...(viewer.isAsker ? { connection: row.asker_conn, answer_seen_at: row.answer_seen_at } : {})
  }
}

export async function loadQuestion(id: string): Promise<QuestionRow | null> {
  if (!UUID_RE.test(id)) return null
  return ((await db('nivaro_agent_questions').where({ id }).first()) ?? null) as QuestionRow | null
}

/** Asker (the person the connection acts as), recipient, or an administrator. */
export function canSeeQuestion(req: FastifyRequest, row: QuestionRow): boolean {
  const me = String(req.user?.id ?? '')
  return !!req.isAdmin || same(row.asker, me) || same(row.recipient, me)
}

function clip(s: string, n: number) {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export async function askQuestion(
  app: FastifyInstance,
  req: FastifyRequest,
  input: AskInput
): Promise<QuestionRow> {
  const me = String(req.user!.id)
  const ask = normalizeAsk(input, me)
  const recipient = (await db('nivaro_users')
    .where({ id: ask.to })
    .first('id', 'status', 'account_kind', 'first_name', 'last_name', 'email')) as
    | {
        id: string
        status: string
        account_kind: string | null
        first_name: string | null
        last_name: string | null
        email: string | null
      }
    | undefined
  if (recipient?.status !== 'active' || recipient.account_kind)
    throw new QuestionError(400, 'Questions go to an active person', 'UNKNOWN_RECIPIENT')
  if (ask.collection && ask.item) {
    const { readOne } = await import('./items.js')
    const row = await readOne(req.user!, ask.collection, ask.item, req.workspaceId ?? undefined, [
      'id'
    ]).catch(() => null)
    if (!row) throw new QuestionError(404, 'Record not found', 'NOT_FOUND')
  }
  const conn = mcpConnOf(req) ?? `u${me.toLowerCase()}`
  const now = new Date()
  const [byConn, byRecipient] = (await Promise.all([
    db('nivaro_agent_questions')
      .where({ asker_conn: conn, status: 'open' })
      .where('expires_at', '>', now)
      .count('* as n')
      .first(),
    db('nivaro_agent_questions')
      .where({ asker_conn: conn, status: 'open', recipient: recipient.id })
      .where('expires_at', '>', now)
      .count('* as n')
      .first()
  ])) as Array<{ n: number | string } | undefined>
  if (Number(byConn?.n ?? 0) >= MAX_OPEN_PER_CONN)
    throw new QuestionError(
      429,
      `This connection already has ${MAX_OPEN_PER_CONN} unanswered questions. Wait for answers, or cancel some.`,
      'TOO_MANY_QUESTIONS'
    )
  if (Number(byRecipient?.n ?? 0) >= MAX_OPEN_PER_RECIPIENT)
    throw new QuestionError(
      429,
      `${personName(recipient) ?? 'That person'} already has ${MAX_OPEN_PER_RECIPIENT} unanswered questions from this connection.`,
      'TOO_MANY_QUESTIONS'
    )

  const askerName = mcpClientNameOf(req).slice(0, 200)
  const row: QuestionRow = {
    id: randomUUID(),
    asker_conn: conn,
    asker_name: askerName,
    asker: me,
    recipient: recipient.id,
    question: ask.question,
    choices: ask.choices.length ? JSON.stringify(ask.choices) : null,
    allow_text: ask.allowText,
    collection: ask.collection,
    item: ask.item,
    status: 'open',
    answer: null,
    answer_choice: null,
    answered_by: null,
    answered_at: null,
    answer_seen_at: null,
    expires_at: new Date(now.getTime() + ask.minutes * 60_000),
    created_at: now,
    updated_at: now
  }
  await db('nivaro_agent_questions').insert(row)

  const forMe = same(recipient.id, me)
  const who = (await names([me])).get(me.toLowerCase()) ?? null
  const choicesLine = ask.choices.length ? `\n\nChoices: ${ask.choices.join(' · ')}` : ''
  try {
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, recipient.id, {
      subject: `${askerName} asks: ${clip(ask.question, 90)}`,
      message: `${ask.question}${choicesLine}`.slice(0, 2000),
      category: 'mentions',
      always_inbox: true,
      sender: forMe ? null : me,
      collection: ask.collection,
      item: ask.item,
      // `question:<id>` offers an inline Answer on the notification; a choices-only question
      // (`:choices`) opens My Work, where the choices are buttons.
      target: {
        kind: 'my_work',
        focus: `question:${row.id}${ask.allowText ? '' : ':choices'}`,
        action: ask.allowText ? 'reply' : 'open'
      },
      source: { kind: 'agent-question', label: askerName, id: row.id },
      why: forMe
        ? `${askerName}, an assistant connected to your account, is waiting for your answer`
        : `${askerName}, an assistant acting for ${who ?? 'a colleague'}, is waiting for your answer`
    })
  } catch {
    /* the question stands; My Work lists it even when the notification did not land */
  }
  pushQuestionChange(row.id, ['status'])
  return row
}

/** Tell live MCP sessions (subscribed to nivaro://question/<id>) and open tabs. */
export function pushQuestionChange(id: string, fields: string[]): void {
  void import('./realtime.js')
    .then(({ broadcastCollectionUpdate }) =>
      broadcastCollectionUpdate(undefined, 'nivaro_agent_questions', id, {
        changed_fields: fields
      })
    )
    .catch(() => undefined)
}

export async function answerQuestion(
  req: FastifyRequest,
  id: string,
  body: { choice?: unknown; answer?: unknown }
): Promise<QuestionRow> {
  if (!isHumanSession(req))
    throw new QuestionError(
      403,
      'Only the person asked can answer, from their own signed-in session',
      'HUMAN_ONLY'
    )
  const row = await loadQuestion(id)
  if (!row) throw new QuestionError(404, 'Not found')
  if (!same(row.recipient, req.user!.id)) {
    // Someone else's question: not theirs to see either, unless they are its asker or an admin.
    if (canSeeQuestion(req, row))
      throw new QuestionError(403, 'Only the person asked can answer', 'NOT_RECIPIENT')
    throw new QuestionError(404, 'Not found')
  }
  const status = effectiveStatus(row)
  if (status !== 'open')
    throw new QuestionError(409, `This question is already ${status}`, 'NOT_OPEN')
  const choices = parseChoices(row.choices)
  const choice = body.choice == null || body.choice === '' ? null : String(body.choice)
  const text = body.answer == null ? '' : String(body.answer).trim()
  if (choice != null && !choices.includes(choice))
    throw new QuestionError(400, 'That is not one of the choices')
  if (text.length > MAX_ANSWER)
    throw new QuestionError(400, `An answer is at most ${MAX_ANSWER} characters`)
  if (text && !row.allow_text && choice == null)
    throw new QuestionError(400, 'Pick one of the choices')
  if (!row.allow_text && choice == null) throw new QuestionError(400, 'Pick one of the choices')
  if (choice == null && !text) throw new QuestionError(400, 'Write an answer')
  const now = new Date()
  const n = await db('nivaro_agent_questions')
    .where({ id, status: 'open' })
    .where('expires_at', '>', now)
    .update({
      status: 'answered',
      answer: text || null,
      answer_choice: choice,
      answered_by: req.user!.id,
      answered_at: now,
      updated_at: now
    })
  if (Number(n) !== 1)
    throw new QuestionError(409, 'This question was closed meanwhile', 'NOT_OPEN')
  pushQuestionChange(id, ['status', 'answer'])
  return (await loadQuestion(id)) as QuestionRow
}

export async function cancelQuestion(req: FastifyRequest, id: string): Promise<QuestionRow> {
  const row = await loadQuestion(id)
  if (!row || !canSeeQuestion(req, row)) throw new QuestionError(404, 'Not found')
  if (!same(row.asker, req.user!.id) && !req.isAdmin)
    throw new QuestionError(403, 'Only the asker can withdraw a question')
  if (effectiveStatus(row) !== 'open')
    throw new QuestionError(409, `This question is already ${effectiveStatus(row)}`, 'NOT_OPEN')
  await db('nivaro_agent_questions')
    .where({ id, status: 'open' })
    .update({ status: 'cancelled', updated_at: new Date() })
  pushQuestionChange(id, ['status'])
  return (await loadQuestion(id)) as QuestionRow
}

/** The asking connection collected the answer: my_work stops listing it. */
export async function markAnswerSeen(row: QuestionRow): Promise<void> {
  if (row.status !== 'answered' || row.answer_seen_at) return
  await db('nivaro_agent_questions')
    .where({ id: row.id })
    .whereNull('answer_seen_at')
    .update({ answer_seen_at: new Date() })
    .catch(() => undefined)
}

/** Wait (polling the row) until the question is no longer open, up to `seconds`. */
export async function waitForAnswer(
  id: string,
  seconds: number,
  opts: { intervalMs?: number; signal?: { aborted: boolean } } = {}
): Promise<QuestionRow | null> {
  const until = Date.now() + Math.min(Math.max(seconds, 0), MAX_WAIT_S) * 1000
  const every = opts.intervalMs ?? 1500
  let row = await loadQuestion(id)
  while (row && effectiveStatus(row) === 'open' && Date.now() < until && !opts.signal?.aborted) {
    await new Promise((r) => setTimeout(r, Math.min(every, Math.max(until - Date.now(), 0))))
    row = await loadQuestion(id)
  }
  return row
}

/** Questions waiting on this person (newest first). */
export async function openQuestionsFor(userId: string, limit = 50): Promise<QuestionRow[]> {
  if (!(await questionsReady())) return []
  return (await db('nivaro_agent_questions')
    .where({ recipient: userId, status: 'open' })
    .where('expires_at', '>', new Date())
    .orderBy('created_at', 'desc')
    .limit(limit)) as QuestionRow[]
}

/** What this connection asked: open ones and answers it has not collected yet. */
export async function questionsAskedBy(
  conn: string,
  opts: { status?: string; limit?: number } = {}
): Promise<QuestionRow[]> {
  if (!(await questionsReady())) return []
  const q = db('nivaro_agent_questions').where({ asker_conn: conn })
  if (opts.status === 'unseen') q.where({ status: 'answered' }).whereNull('answer_seen_at')
  else if (opts.status === 'open') q.where({ status: 'open' }).where('expires_at', '>', new Date())
  else if (opts.status && opts.status !== 'all') q.where({ status: opts.status })
  return (await q
    .orderBy('created_at', 'desc')
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200))) as QuestionRow[]
}

export async function expireQuestions(): Promise<number> {
  if (!(await questionsReady())) return 0
  const now = new Date()
  const ids = (
    (await db('nivaro_agent_questions')
      .where({ status: 'open' })
      .where('expires_at', '<=', now)
      .limit(500)
      .select('id')) as Array<{ id: string }>
  ).map((r) => r.id)
  if (!ids.length) return 0
  await db('nivaro_agent_questions')
    .whereIn('id', ids)
    .where({ status: 'open' })
    .update({ status: 'expired', updated_at: now })
  for (const id of ids) pushQuestionChange(id, ['status'])
  return ids.length
}

export { names as questionNames }
