import type {
  ChatActionMessage,
  ChatMessageActionDef,
  ChatMessageActionResult,
  ChatMessageActionWhen
} from '@nivaro/extension-kit'

/**
 * Items extensions add to a chat message's menu (#2763) — beside the slash
 * commands in chat-commands.ts. The list a room offers is filtered by room
 * kind here; the message-shape checks (text, attachments, own message, text
 * pattern) ride to the client so one list serves every message in the room,
 * and the run route checks the whole `when` again on the server. The handler
 * runs AS the person clicking — the route checks they can see the room — and
 * text it returns to post goes through postChatMessage like anyone's message.
 */

const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const KINDS = new Set(['general', 'channel', 'entity', 'dm'])

interface Registered {
  extension: string
  key: string
  def: ChatMessageActionDef
  when: ChatMessageActionWhen
}

const actions = new Map<string, Registered>()

/** Pure: a declared `when` reduced to its known keys and sane values. */
export function normalizeWhen(raw: unknown): ChatMessageActionWhen | null {
  if (raw == null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const w = raw as Record<string, unknown>
  const out: ChatMessageActionWhen = {}
  if (w.room_kinds != null) {
    if (!Array.isArray(w.room_kinds)) return null
    const kinds = w.room_kinds.map(String).filter((k) => KINDS.has(k))
    if (kinds.length !== w.room_kinds.length) return null
    out.room_kinds = kinds as ChatMessageActionWhen['room_kinds']
  }
  if (w.room_prefixes != null) {
    if (!Array.isArray(w.room_prefixes)) return null
    out.room_prefixes = w.room_prefixes.map((p) => String(p).toUpperCase()).filter(Boolean)
  }
  for (const k of ['has_text', 'has_attachments', 'own_messages'] as const)
    if (w[k] === true) out[k] = true
  if (typeof w.text_pattern === 'string' && w.text_pattern) {
    try {
      new RegExp(w.text_pattern, 'i')
    } catch {
      return null
    }
    out.text_pattern = w.text_pattern.slice(0, 200)
  }
  return out
}

/** Returns false (and registers nothing) for a bad id, label, handler or `when`. */
export function registerChatMessageAction(extension: string, def: ChatMessageActionDef): boolean {
  const id = String(def?.id ?? '').toLowerCase()
  const label = String(def?.label ?? '').trim()
  if (!ID_RE.test(id) || !label || typeof def.handler !== 'function') return false
  const when = normalizeWhen(def.when)
  if (!when) return false
  const key = `${extension}:${id}`
  actions.set(key, {
    extension,
    key,
    def: { ...def, id, label: label.slice(0, 60) },
    when
  })
  return true
}

export function unregisterChatMessageActions(extension: string): void {
  for (const [k, v] of actions) if (v.extension === extension) actions.delete(k)
}

/** Test seam: replaced in tests so the loader (and its imports) never loads. */
let isEnabled: (extension: string) => Promise<boolean> = async (extension) => {
  const { extensionRegistry } = await import('../extensions/loader.js')
  return extensionRegistry.get(extension)?.enabled !== false
}
export function _setMessageActionsEnabledCheck(fn: typeof isEnabled): void {
  isEnabled = fn
}
export function _resetChatMessageActions(): void {
  actions.clear()
}

/** Room kind + record prefix of a room key — parseRoom's (services/chat.ts)
 *  spelling, kept here so the loader's import of this registry stays light. Pure. */
export function roomKind(room: string): { kind: string; prefix: string | null } {
  const key = String(room ?? '').trim()
  if (key === 'global') return { kind: 'general', prefix: null }
  if (key.startsWith('dm:')) return { kind: 'dm', prefix: null }
  if (key.startsWith('ch:')) return { kind: key.length > 3 ? 'channel' : 'unknown', prefix: null }
  const idx = key.indexOf(':')
  return idx > 0
    ? { kind: 'entity', prefix: key.slice(0, idx).toUpperCase() }
    : { kind: 'unknown', prefix: null }
}

/** Pure: is a room of this key offered the action (room kind + prefix)? */
export function roomMatches(when: ChatMessageActionWhen, room: string): boolean {
  const { kind, prefix } = roomKind(room)
  if (kind === 'unknown') return false
  if (when.room_prefixes?.length) {
    if (kind !== 'entity') return false
    if (!when.room_prefixes.includes(prefix ?? '')) return false
  }
  if (when.room_kinds?.length && !when.room_kinds.includes(kind as never)) return false
  return true
}

/** Pure: does this message have the shape the action asks for? */
export function messageMatches(
  when: ChatMessageActionWhen,
  msg: Pick<ChatActionMessage, 'message' | 'attachments' | 'sender'>,
  userId: string
): boolean {
  const text = String(msg.message ?? '')
  if (when.has_text && !text.trim()) return false
  if (when.has_attachments && !(msg.attachments ?? []).length) return false
  if (when.own_messages && String(msg.sender ?? '').toUpperCase() !== userId.toUpperCase())
    return false
  if (when.text_pattern) {
    try {
      if (!new RegExp(when.text_pattern, 'i').test(text)) return false
    } catch {
      return false
    }
  }
  return true
}

export interface MessageActionListing {
  key: string
  id: string
  extension: string
  label: string
  description: string | null
  /** Message-shape checks the client applies per message. */
  when: Pick<
    ChatMessageActionWhen,
    'has_text' | 'has_attachments' | 'own_messages' | 'text_pattern'
  >
}

/** The actions a room offers (enabled extensions, matching room kind). */
export async function listChatMessageActions(room: string): Promise<MessageActionListing[]> {
  const out: MessageActionListing[] = []
  for (const a of actions.values()) {
    if (!roomMatches(a.when, room)) continue
    if (!(await isEnabled(a.extension))) continue
    const { room_kinds: _k, room_prefixes: _p, ...shape } = a.when
    out.push({
      key: a.key,
      id: a.def.id,
      extension: a.extension,
      label: a.def.label,
      description: a.def.description ? String(a.def.description).slice(0, 140) : null,
      when: shape
    })
  }
  return out.sort((x, y) => x.label.localeCompare(y.label))
}

export function describeChatMessageActions(
  extension: string
): Array<{ id: string; label: string; when: ChatMessageActionWhen }> {
  return [...actions.values()]
    .filter((a) => a.extension === extension)
    .map((a) => ({ id: a.def.id, label: a.def.label, when: a.when }))
}

const OPEN_URL_RE = /^(https?:\/\/[^\s]+|\/[^\s/][^\s]*)$/i

/**
 * Run one action on a message the caller can already see. null = no such
 * action (or its extension is off, or it does not apply to this message).
 * The result is capped; `open_url` must be an http(s) link or an app path.
 */
export async function runChatMessageAction(
  key: string,
  msg: ChatActionMessage,
  userId: string
): Promise<ChatMessageActionResult | null> {
  const a = actions.get(key)
  if (!a || !(await isEnabled(a.extension))) return null
  if (!roomMatches(a.when, msg.room) || !messageMatches(a.when, msg, userId)) return null
  const out = await a.def.handler(msg, { userId, room: msg.room })
  if (!out) return {}
  const url = typeof out.open_url === 'string' ? out.open_url.trim() : ''
  return {
    post: out.post ? String(out.post).slice(0, 8000) : undefined,
    in_thread: out.in_thread === true,
    reply: out.reply ? String(out.reply).slice(0, 2000) : undefined,
    open_url: url && OPEN_URL_RE.test(url) ? url.slice(0, 2000) : undefined
  }
}
