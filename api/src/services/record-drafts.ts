import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db/index.js'

/**
 * Record-form drafts that follow a person between devices (rt4 #21; table nivaro_drafts,
 * migration 316, routes/drafts.ts).
 *
 * - Own rows only, always (the routes never take a user id).
 * - Sealed at rest: the stored text is AES-256-GCM ciphertext under a key derived from
 *   SESSION_SECRET, so a database reader sees no field values. Rows written before this are
 *   plain JSON and still read (the next save seals them).
 * - A draft lives 7 days from its last save (`DRAFT_TTL_MS`): a read past that deletes it and
 *   answers "none", a save prunes the person's own stale rows, and a nightly cron sweeps the
 *   rest. Layout-editor staged steps share the table and are never touched here.
 * - On the way back out, fields the person may no longer edit are dropped (`filterDraftFields`).
 */

export const DRAFT_TTL_MS = 7 * 86_400_000
export const DRAFT_PAYLOAD_CAP = 256 * 1024
/** Staged layout-editor steps live in the same table (services/layout-staged.ts). */
export const LAYOUT_STAGED_COLLECTION = 'layout-editor'

const SEAL_PREFIX = 'enc:d1:'

export interface DraftDevice {
  /** A random per-browser id (the same browser keeps it). */
  id: string
  /** "laptop", "phone", "tablet" or "computer" — never a hostname or an address. */
  label: string
}

/** The sealed envelope. */
interface Envelope {
  v: 1
  payload: Record<string, unknown>
  device: DraftDevice | null
}

function sealKey(): Buffer {
  // A purpose-bound key: the session secret itself is never the cipher key.
  return Buffer.from(
    hkdfSync('sha256', String(config.SESSION_SECRET), 'nivaro-drafts', 'record-drafts-v1', 32)
  )
}

export function sealDraft(payload: Record<string, unknown>, device: DraftDevice | null): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sealKey(), iv)
  const text = JSON.stringify({ v: 1, payload, device } satisfies Envelope)
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return `${SEAL_PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

export function openDraft(
  stored: string
): { payload: Record<string, unknown>; device: DraftDevice | null } | null {
  try {
    if (!stored.startsWith(SEAL_PREFIX)) {
      // Legacy row: the StoredDraft itself, unsealed, from no known device.
      const legacy = JSON.parse(stored)
      return legacy && typeof legacy === 'object' ? { payload: legacy, device: null } : null
    }
    const [iv, tag, ct] = stored.slice(SEAL_PREFIX.length).split(':')
    const decipher = createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const text = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()])
    const env = JSON.parse(text.toString('utf8')) as Envelope
    if (!env || env.v !== 1 || !env.payload || typeof env.payload !== 'object') return null
    return { payload: env.payload, device: cleanDevice(env.device) }
  } catch {
    // A row sealed under another secret (a restored database) is simply unreadable: no draft.
    return null
  }
}

/** A device tag from a request body: short id + one of a few plain labels, or null. */
export function cleanDevice(raw: unknown): DraftDevice | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as { id?: unknown; label?: unknown }
  const id = typeof d.id === 'string' ? d.id.trim().slice(0, 64) : ''
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null
  const label = typeof d.label === 'string' ? d.label.trim().toLowerCase() : ''
  return {
    id,
    label: ['laptop', 'phone', 'tablet', 'computer'].includes(label) ? label : 'computer'
  }
}

/** Has a draft saved at `savedAt` outlived its 7 days? */
export function draftExpired(savedAt: Date | string | number, now: number = Date.now()): boolean {
  const t = new Date(savedAt).getTime()
  return Number.isNaN(t) || now - t > DRAFT_TTL_MS
}

/**
 * The draft as this person may restore it NOW: scalar fields (and their loaded values and
 * "filled" marks) are kept only when `allowed` lists them (`null` = every field). Returns the
 * trimmed payload and how many fields were left out. Staged lines and links are not filtered
 * here — they are written through the items service on save, which judges them itself.
 */
export function filterDraftFields(
  payload: Record<string, unknown>,
  allowed: string[] | null
): { payload: Record<string, unknown>; dropped: number } {
  if (allowed === null || allowed.includes('*')) return { payload, dropped: 0 }
  const ok = new Set(allowed)
  const fields = (payload.fields ?? {}) as Record<string, unknown>
  const base = (payload.base ?? {}) as Record<string, unknown>
  const keep = Object.keys(fields).filter((k) => ok.has(k))
  const dropped = Object.keys(fields).length - keep.length
  if (dropped === 0) return { payload, dropped: 0 }
  const pick = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => ok.has(k)))
  const filled = Array.isArray(payload.filled)
    ? (payload.filled as unknown[]).filter((k) => typeof k === 'string' && ok.has(k))
    : undefined
  return {
    payload: {
      ...payload,
      fields: pick(fields),
      base: pick(base),
      ...(filled ? { filled } : {})
    },
    dropped
  }
}

/** Delete one person's drafts past their 7 days (record drafts only). */
export async function pruneOwnDrafts(userId: string): Promise<void> {
  await db('nivaro_drafts')
    .where({ user: userId })
    .whereNot('collection', LAYOUT_STAGED_COLLECTION)
    .where('saved_at', '<', new Date(Date.now() - DRAFT_TTL_MS))
    .delete()
}

/** Nightly sweep: every record draft past 7 days. Returns how many went. */
export async function pruneExpiredDrafts(): Promise<number> {
  return Number(
    await db('nivaro_drafts')
      .whereNot('collection', LAYOUT_STAGED_COLLECTION)
      .where('saved_at', '<', new Date(Date.now() - DRAFT_TTL_MS))
      .delete()
  )
}
