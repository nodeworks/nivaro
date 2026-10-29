/**
 * The audience confirm on save (#3080) — see services/audience-preview.ts for who counts.
 *
 * Every save route of a config that sends to people (alert definitions, rules, flows and their
 * mail / notification steps, field watches, broadcasts) calls `checkAudienceConfirm` before it
 * writes. When the saved config would reach more than the instance's threshold, a whole role or
 * everyone — and the save ADDS someone (a create, turning it on, or new people / roles) — the
 * route answers 409 AUDIENCE_CONFIRM_REQUIRED with the preview unless the body carries
 * `confirm_audience: true`. A confirmed save is logged as `audience-confirm` on the config row.
 *
 * The threshold lives under the `audience_confirm` key of THIS instance's
 * nivaro_settings_overrides row (next to `huddle`, `layout_style`) — admin-only, no migration.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import {
  AUDIENCE_TABLE,
  type AudienceKind,
  type AudiencePreview,
  audienceKeys,
  previewConfigAudience
} from './audience-preview.js'
import { instanceKey } from './instance-key.js'
import { currentTenantKey } from './tenant-rooms.js'

export const AUDIENCE_CONFIRM_KEY = 'audience_confirm'
export const DEFAULT_AUDIENCE_THRESHOLD = 10
export const MAX_AUDIENCE_THRESHOLD = 100_000

export interface AudienceConfirmSettings {
  /** A save that reaches MORE than this many people asks first. */
  threshold: number
}

export class AudienceSettingsError extends Error {}

export function normalizeAudienceSettings(raw: unknown): AudienceConfirmSettings {
  const o =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const n = Number(o.threshold)
  return {
    threshold:
      Number.isInteger(n) && n >= 0 && n <= MAX_AUDIENCE_THRESHOLD ? n : DEFAULT_AUDIENCE_THRESHOLD
  }
}

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    const parsed = row.data ? JSON.parse(row.data) : {}
    return {
      id: row.id,
      data: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    }
  } catch {
    return { id: row.id, data: {} }
  }
}

// Per tenant: a cloud process serves many tenants' databases.
const cache = new Map<string, { at: number; value: AudienceConfirmSettings }>()
const TTL_MS = 30_000

export function bustAudienceSettingsCache(): void {
  cache.clear()
}

export async function getAudienceSettings(): Promise<AudienceConfirmSettings> {
  const tenant = currentTenantKey()
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  let value: AudienceConfirmSettings = { threshold: DEFAULT_AUDIENCE_THRESHOLD }
  try {
    value = normalizeAudienceSettings((await readRow())?.data[AUDIENCE_CONFIRM_KEY])
  } catch {
    /* table missing / unreadable: the default */
  }
  cache.set(tenant, { at: Date.now(), value })
  if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  return value
}

export async function saveAudienceSettings(patch: unknown): Promise<AudienceConfirmSettings> {
  const p =
    patch && typeof patch === 'object' && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {}
  if ('threshold' in p) {
    const n = Number(p.threshold)
    if (!Number.isInteger(n) || n < 0 || n > MAX_AUDIENCE_THRESHOLD)
      throw new AudienceSettingsError(
        `threshold must be a whole number from 0 to ${MAX_AUDIENCE_THRESHOLD}`
      )
  }
  const row = await readRow()
  const next = normalizeAudienceSettings({
    ...normalizeAudienceSettings(row?.data[AUDIENCE_CONFIRM_KEY]),
    ...p
  })
  const data = { ...(row?.data ?? {}), [AUDIENCE_CONFIRM_KEY]: next }
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  }
  bustAudienceSettingsCache()
  return next
}

/** Preview for a draft with the instance threshold applied. */
export async function previewAudience(kind: AudienceKind, draft: Record<string, unknown>) {
  const { threshold } = await getAudienceSettings()
  return previewConfigAudience(kind, draft, threshold)
}

/** Whether `after` reaches anyone (or any role) `before` did not — or `before` was off. */
export function addsAudience(
  before: { preview: AudiencePreview; ids: string[] } | null,
  after: { preview: AudiencePreview; ids: string[] }
): boolean {
  if (!before || !before.preview.active) return true
  const had = audienceKeys(before.preview, before.ids)
  for (const k of audienceKeys(after.preview, after.ids)) if (!had.has(k)) return true
  // Addresses outside the user table carry no id: a larger external count is new reach.
  return after.preview.external_addresses > before.preview.external_addresses
}

/** The body flag, read from any save body. */
export function confirmFlag(body: unknown): boolean {
  const v = (body as { confirm_audience?: unknown } | null | undefined)?.confirm_audience
  return v === true || v === 'true' || v === 1
}

export interface AudienceCheck {
  /** True = the route already answered 409; it must return without writing. */
  blocked: boolean
  /** Set when the save went ahead on a confirm: call `logAudienceConfirm` after the write. */
  confirmed: AudiencePreview | null
}

/**
 * Asks before a save. `after` is the config as it will be stored; `before` the stored row (null
 * on create). Never throws: a preview that cannot run lets the save through (the confirm is a
 * guard rail for admins, not an access check).
 */
export async function checkAudienceConfirm(
  req: FastifyRequest,
  reply: FastifyReply,
  kind: AudienceKind,
  after: Record<string, unknown>,
  before: Record<string, unknown> | null
): Promise<AudienceCheck> {
  let next: { preview: AudiencePreview; ids: string[] }
  let prev: { preview: AudiencePreview; ids: string[] } | null = null
  try {
    next = await previewAudience(kind, after)
    if (!next.preview.confirm_required) return { blocked: false, confirmed: null }
    if (before) prev = await previewAudience(kind, before)
  } catch (err) {
    req.log?.warn?.({ err, kind }, 'audience preview failed; save goes ahead')
    return { blocked: false, confirmed: null }
  }
  if (!addsAudience(prev, next)) return { blocked: false, confirmed: null }
  if (confirmFlag(req.body)) return { blocked: false, confirmed: next.preview }
  const p = next.preview
  const who = p.includes_everyone
    ? 'everyone'
    : p.includes_roles.length
      ? `${p.count} people, including the whole ${p.includes_roles.map((r) => r.name).join(', ')} role${p.includes_roles.length > 1 ? 's' : ''}`
      : `${p.count} people`
  await reply.code(409).send({
    error: `Saving this tells ${who}. Check the list, then save again to confirm.`,
    code: 'AUDIENCE_CONFIRM_REQUIRED',
    audience: p
  })
  return { blocked: true, confirmed: null }
}

/** Logs a confirmed save on the config row — counts only, never names. */
export async function logAudienceConfirm(
  req: FastifyRequest,
  kind: AudienceKind,
  item: string | number,
  preview: AudiencePreview
): Promise<void> {
  await logActivity({
    action: 'audience-confirm',
    user: req.user?.id ?? null,
    collection: AUDIENCE_TABLE[kind],
    item: String(item),
    comment: JSON.stringify({
      kind,
      count: preview.count,
      roles: preview.includes_roles.length > 0,
      everyone: preview.includes_everyone
    }),
    req
  }).catch(() => null)
}
