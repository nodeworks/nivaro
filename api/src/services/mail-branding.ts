import { AsyncLocalStorage } from 'node:async_hooks'
import { db } from '../db/index.js'

/**
 * Mail branding per workspace (#1463).
 *
 * Every email leaves through base.liquid, which reads a `brand` object off the
 * template context: logo, accent colour, sender name, footer line. This module
 * decides what that object holds for one send:
 *
 *   explicit workspace id → the record's collection's workspace →
 *   the recipient's current workspace → the instance branding
 *
 * Each FIELD falls back on its own — a workspace that only sets a colour keeps
 * the instance logo and name. The instance values come from nivaro_settings
 * (project_name, project_color); with nothing configured anywhere the chrome
 * is the stock Nivaro navy/cyan the templates always had.
 *
 * Nothing here may throw: a branding lookup that fails answers the instance
 * values, and a send never waits on more than a cached read.
 */

export const DEFAULT_SENDER_NAME = 'Nivaro'
export const DEFAULT_ACCENT = '#00ceff'

export interface MailBrand {
  /** A public URL or data URI, or null for the text-only header. */
  logo: string | null
  /** #rrggbb — the header rule + brand mark. */
  color: string
  /** The name in "Sent by …" (the instance's project name when the workspace sets none). */
  sender_name: string
  /** Set ONLY when the workspace names a sender: the From display name. */
  from_name: string | null
  /** Plain text appended under the standard footer sentence. */
  footer: string | null
  workspace_id: string | null
}

export interface MailBrandingLookup {
  workspaceId?: string | null
  /** The record the email is about — its collection's workspace decides. */
  recordCollection?: string | null
  recordId?: string | number | null
  /** The recipient — their current workspace is the last resort before the instance. */
  recipientUserId?: string | null
  recipientEmail?: string | null
}

interface WorkspaceBrandRow {
  mail_logo: string | null
  mail_color: string | null
  mail_sender_name: string | null
  mail_footer: string | null
}

interface InstanceBrand {
  logo: string | null
  color: string | null
  sender_name: string | null
}

const TTL_MS = 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HEX_RE = /^#[0-9a-f]{6}$/i

let instanceCache: { at: number; value: InstanceBrand } | null = null
const workspaceCache = new Map<string, { at: number; value: WorkspaceBrandRow | null }>()
const collectionWorkspaceCache = new Map<string, { at: number; value: string | null }>()

/** Called by the workspaces + settings routes after a write (and by the ops cache registry). */
export function bustMailBrandingCache(): void {
  instanceCache = null
  workspaceCache.clear()
  collectionWorkspaceCache.clear()
}

// ── render-scope context ─────────────────────────────────────────────────────
// The mail-type harness renders dozens of templates through the same engine
// calls production uses; a per-call option would mean threading a workspace id
// through every builder. The route wraps the render instead, and the resolver
// reads the scope when the caller named no workspace of its own.

const scope = new AsyncLocalStorage<{ workspaceId: string | null }>()

export function runWithMailBranding<T>(
  ctx: { workspaceId?: string | null },
  fn: () => Promise<T>
): Promise<T> {
  return scope.run({ workspaceId: normalizeId(ctx.workspaceId) }, fn)
}

export function currentMailBrandingWorkspace(): string | null {
  return scope.getStore()?.workspaceId ?? null
}

// ── normalisation ────────────────────────────────────────────────────────────

function normalizeId(v: unknown): string | null {
  const s = String(v ?? '').trim()
  return UUID_RE.test(s) ? s.toUpperCase() : null
}

/** A colour the chrome can use: #rrggbb only (an email attribute, never free text). */
export function normalizeMailColor(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  const hex = s.startsWith('#') ? s : `#${s}`
  return HEX_RE.test(hex) ? hex.toLowerCase() : null
}

/** A logo the mail client can fetch without a session: https(s) URL or an image data URI. */
export function normalizeMailLogo(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s || s.length > 1000) return null
  // Attribute-safe by construction: no whitespace, quotes, angle brackets or backticks.
  if (/^https?:\/\/[^\s"'<>`]+$/i.test(s)) return s
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(s)) return s
  return null
}

function cleanText(v: unknown, max: number): string | null {
  const s = String(v ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s ? s.slice(0, max) : null
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )

// ── reads ────────────────────────────────────────────────────────────────────

async function instanceBranding(): Promise<InstanceBrand> {
  if (instanceCache && Date.now() - instanceCache.at < TTL_MS) return instanceCache.value
  let value: InstanceBrand = { logo: null, color: null, sender_name: null }
  try {
    // The settings singleton (id 1) — read the way routes/auth.ts's branding does.
    const row = (await db('nivaro_settings')
      .where({ id: 1 })
      .first('project_name', 'project_color', 'brand_logo')) as Record<string, unknown> | undefined
    // brand_logo is a nivaro_files id served behind authentication — a mail
    // client cannot fetch it, so it only counts when it is already a public
    // URL or a data URI (an operator may paste one).
    value = {
      logo: normalizeMailLogo(row?.brand_logo),
      color: normalizeMailColor(row?.project_color),
      sender_name: cleanText(row?.project_name, 200)
    }
  } catch {
    // Settings table unreadable (boot, tests) — stock chrome.
  }
  instanceCache = { at: Date.now(), value }
  return value
}

async function workspaceBranding(id: string): Promise<WorkspaceBrandRow | null> {
  const hit = workspaceCache.get(id)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  let value: WorkspaceBrandRow | null = null
  try {
    const row = (await db('nivaro_workspaces')
      .where({ id })
      .first('mail_logo', 'mail_color', 'mail_sender_name', 'mail_footer')) as
      | WorkspaceBrandRow
      | undefined
    value = row ?? null
  } catch {
    // Column set behind migration 394, or the table unreadable — instance chrome.
    value = null
  }
  workspaceCache.set(id, { at: Date.now(), value })
  return value
}

async function workspaceOfCollection(collection: string): Promise<string | null> {
  const key = collection.toLowerCase()
  const hit = collectionWorkspaceCache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  let value: string | null = null
  try {
    const row = (await db('nivaro_collections').where({ collection }).first('workspace')) as
      | { workspace?: string | null }
      | undefined
    value = normalizeId(row?.workspace)
  } catch {
    value = null
  }
  collectionWorkspaceCache.set(key, { at: Date.now(), value })
  return value
}

async function workspaceOfRecipient(
  userId: string | null | undefined,
  email: string | null | undefined
): Promise<string | null> {
  try {
    let q = db('nivaro_users')
    if (userId) q = q.where({ id: userId })
    else {
      const addr = String(email ?? '')
        .trim()
        .toLowerCase()
      if (!addr.includes('@')) return null
      q = q.whereRaw('LOWER(email) = ?', [addr])
    }
    const row = (await q.first('current_workspace')) as
      | { current_workspace?: string | null }
      | undefined
    return normalizeId(row?.current_workspace)
  } catch {
    return null
  }
}

/** Which workspace a send belongs to, by the documented precedence; null = none. */
export async function resolveMailWorkspace(lookup: MailBrandingLookup): Promise<string | null> {
  const explicit = normalizeId(lookup.workspaceId) ?? currentMailBrandingWorkspace()
  if (explicit) return explicit
  const collection = String(lookup.recordCollection ?? '').trim()
  if (collection && !/^nivaro_/i.test(collection)) {
    const ws = await workspaceOfCollection(collection)
    if (ws) return ws
  }
  if (lookup.recipientUserId || lookup.recipientEmail) {
    return workspaceOfRecipient(lookup.recipientUserId, lookup.recipientEmail)
  }
  return null
}

/** The brand one send carries — never throws, never waits on more than cached reads. */
export async function resolveMailBranding(lookup: MailBrandingLookup = {}): Promise<MailBrand> {
  const instance = await instanceBranding()
  let workspaceId: string | null = null
  let ws: WorkspaceBrandRow | null = null
  try {
    workspaceId = await resolveMailWorkspace(lookup)
    if (workspaceId) ws = await workspaceBranding(workspaceId)
  } catch {
    workspaceId = null
    ws = null
  }
  const wsName = cleanText(ws?.mail_sender_name, 200)
  return {
    logo: normalizeMailLogo(ws?.mail_logo) ?? instance.logo,
    color: normalizeMailColor(ws?.mail_color) ?? instance.color ?? DEFAULT_ACCENT,
    sender_name: wsName ?? instance.sender_name ?? DEFAULT_SENDER_NAME,
    from_name: wsName,
    footer: cleanText(ws?.mail_footer, 2000),
    workspace_id: workspaceId
  }
}

// ── template context + From header ───────────────────────────────────────────

/** The `brand` object base.liquid reads — text pre-escaped (LiquidJS does not
 *  escape output), the colour and logo already validated to attribute-safe
 *  shapes, so a workspace admin's input can never break out of the chrome. */
export function brandTemplateContext(brand: MailBrand): Record<string, unknown> {
  return {
    brand: {
      logo: brand.logo ? escapeHtml(brand.logo) : null,
      color: brand.color,
      sender_name: escapeHtml(brand.sender_name),
      footer: brand.footer ? escapeHtml(brand.footer) : null,
      workspace_id: brand.workspace_id
    }
  }
}

/** Resolve + shape in one call; what the engine wrappers merge into `data`
 *  when the caller supplied no `brand` of its own. */
export async function brandContextFor(
  lookup: MailBrandingLookup = {}
): Promise<Record<string, unknown>> {
  return brandTemplateContext(await resolveMailBranding(lookup))
}

/** `"<sender name>" <address>` — the workspace's display name over the
 *  configured From ADDRESS, never a different address. A From that already
 *  carries a display name has it replaced; an unparsable From is kept as is. */
export function applySenderName(from: string, senderName: string | null | undefined): string {
  const name = cleanText(senderName, 200)
  if (!name) return from
  const m = /<([^<>]+)>\s*$/.exec(from)
  const address = (m ? m[1] : from).trim()
  if (!address.includes('@')) return from
  const safe = name.replace(/["\\]/g, '')
  return `"${safe}" <${address}>`
}

/** The list the mail-type harness offers: every workspace, for the preview picker. */
export async function listMailBrandingWorkspaces(): Promise<
  Array<{ id: string; name: string; branded: boolean }>
> {
  try {
    const rows = (await db('nivaro_workspaces')
      .select('id', 'name', 'mail_logo', 'mail_color', 'mail_sender_name', 'mail_footer')
      .orderBy('name')) as Array<WorkspaceBrandRow & { id: string; name: string }>
    return rows.map((r) => ({
      id: String(r.id).toUpperCase(),
      name: r.name,
      branded: !!(r.mail_logo || r.mail_color || r.mail_sender_name || r.mail_footer)
    }))
  } catch {
    return []
  }
}
