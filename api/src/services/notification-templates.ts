import { db } from '../db/index.js'
import { previewMailBody } from './mail.js'

/**
 * Notification templates (#126): per-event wording overrides, stored as
 * nivaro_mail_templates rows named `notification:<event_key>` — which means
 * they're editable in the EXISTING /mail-templates editor, same override/
 * revert lifecycle, no new table. Template contract: the FIRST line renders
 * the subject, everything after it the message. Tokens are Liquid over the
 * context the firing site supplies ({{record}}, {{state}}, {{actor}},
 * {{collection}}, {{changes}} — #384's inline field diff).
 *
 * Returns null when no override exists (or it fails to render) — callers keep
 * their hardcoded wording as the default, so a bad template can never mute a
 * notification.
 */

let cache: Map<string, string> | null = null
let cachedAt = 0
const TTL = 60_000

async function loadOverrides(): Promise<Map<string, string>> {
  if (cache && Date.now() - cachedAt < TTL) return cache
  const m = new Map<string, string>()
  try {
    const rows = (await db('nivaro_mail_templates')
      .where('name', 'like', 'notification:%')
      .select('name', 'body')) as Array<{ name: string; body: string }>
    for (const r of rows) if (r.body?.trim()) m.set(r.name.slice('notification:'.length), r.body)
  } catch {
    // table missing — no overrides
  }
  cache = m
  cachedAt = Date.now()
  return m
}

export function bustNotificationTemplateCache(): void {
  cache = null
}

export async function renderNotificationTemplate(
  eventKey: string,
  ctx: Record<string, unknown>
): Promise<{ subject: string; message: string } | null> {
  const overrides = await loadOverrides()
  const tpl = overrides.get(eventKey)
  if (!tpl) return null
  try {
    const rendered = (await previewMailBody(tpl, ctx)).trim()
    if (!rendered) return null
    const [first, ...rest] = rendered.split('\n')
    const subject = first.trim()
    if (!subject) return null
    return { subject: subject.slice(0, 255), message: rest.join('\n').trim().slice(0, 500) }
  } catch {
    return null
  }
}

/** #384 diff tokens: a compact "field: old → new" list from a revision delta
 *  + previous data, ready to drop in as {{changes}}. */
export function renderChangesToken(
  delta: Record<string, unknown> | null | undefined,
  previous?: Record<string, unknown> | null,
  cap = 8
): string {
  if (!delta) return ''
  const lines: string[] = []
  for (const [k, v] of Object.entries(delta)) {
    if (k.startsWith('_') || k === 'updated_at' || k === 'date_updated') continue
    const before = previous ? previous[k] : undefined
    const fmt = (x: unknown) =>
      x == null || x === '' ? '(empty)' : String(typeof x === 'object' ? JSON.stringify(x) : x).slice(0, 60)
    lines.push(before !== undefined ? `${k}: ${fmt(before)} → ${fmt(v)}` : `${k}: ${fmt(v)}`)
    if (lines.length >= cap) break
  }
  return lines.join('; ')
}
