import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'

/**
 * Custom emoji per workspace (#2459). A row in nivaro_chat_emoji names a
 * `:shortcode:` and points at an image stored through the normal file storage
 * (uploaded private, so it never appears in the file library for anyone but
 * admins — chat serves it through `GET /chat/emoji/:id/image`). Reactions
 * store the emoji as the literal `:shortcode:` text, so a deleted emoji simply
 * renders as that text again.
 */

export const EMOJI_MAX_BYTES = 256 * 1024
export const SHORTCODE_RE = /^[a-z0-9][a-z0-9_+-]{1,39}$/
export const EMOJI_TYPES = ['image/png', 'image/gif', 'image/jpeg', 'image/webp'] as const

export interface EmojiRow {
  id: number
  workspace: string | null
  shortcode: string
  file: string
  created_by: string | null
  created_at: string
}

export function emojiReady(): Promise<boolean> {
  return hasColumn('nivaro_chat_emoji', 'shortcode')
}

/** Lowercase, strip colons and spaces: ":Party Parrot:" -> "party_parrot". */
export function cleanShortcode(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^:+|:+$/g, '')
    .replace(/\s+/g, '_')
}

/** The real image type from the first bytes — a client-supplied mime proves nothing. */
export function sniffImageType(buf: Buffer): (typeof EMOJI_TYPES)[number] | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png'
  if (
    buf.length >= 6 &&
    (buf.subarray(0, 6).toString('latin1') === 'GIF87a' ||
      buf.subarray(0, 6).toString('latin1') === 'GIF89a')
  )
    return 'image/gif'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return null
}

export async function listEmoji(workspace: string | null): Promise<EmojiRow[]> {
  if (!(await emojiReady())) return []
  const rows = (await db('nivaro_chat_emoji')
    .where((q) => {
      q.whereNull('workspace')
      if (workspace) q.orWhere('workspace', workspace)
    })
    .orderBy('shortcode')) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    workspace: r.workspace ? String(r.workspace) : null,
    shortcode: String(r.shortcode),
    file: String(r.file),
    created_by: r.created_by ? String(r.created_by) : null,
    created_at: new Date(String(r.created_at)).toISOString()
  }))
}

/** Is `:code:` a live custom emoji (any workspace)? Reactions accept it. */
export async function customEmojiExists(reaction: string): Promise<boolean> {
  const m = /^:([a-z0-9][a-z0-9_+-]{1,39}):$/.exec(reaction)
  if (!m) return false
  if (!(await emojiReady())) return false
  const row = await db('nivaro_chat_emoji').where({ shortcode: m[1] }).first('id')
  return !!row
}
