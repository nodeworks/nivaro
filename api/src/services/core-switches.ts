import { db } from '../db/index.js'
import { appMap } from './app-state.js'

/**
 * Small instance-wide on/off switches stored without a migration as `nivaro_extension_settings`
 * rows of extension 'nivaro-core' (the same home as `live_mode_role_defaults`), so
 * promote:config carries them with the rest of the configuration. Read through a 30 s memo;
 * a write clears it on this process (others catch up within the memo window).
 */

export const CORE_EXT = 'nivaro-core'

export type CoreSwitch =
  /** Approval request emails carry Approve / Reject decision links (realtime round 9, #21). */
  'approval_email_links'

const memo = appMap<string, { at: number; on: boolean }>()
const TTL_MS = 30_000

export async function coreSwitchOn(key: CoreSwitch): Promise<boolean> {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.on
  let on = false
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: CORE_EXT, key })
      .first('value')) as { value: string | null } | undefined
    on = row?.value === 'on' || row?.value === 'true' || row?.value === '"on"'
  } catch {
    on = false
  }
  memo.set(key, { at: Date.now(), on })
  return on
}

export async function setCoreSwitch(key: CoreSwitch, on: boolean): Promise<void> {
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT, key })
    .first('id')) as { id: number } | undefined
  if (existing) {
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value: on ? 'on' : 'off', updated_at: new Date() })
  } else {
    await db('nivaro_extension_settings').insert({
      extension_id: CORE_EXT,
      key,
      value: on ? 'on' : 'off',
      updated_at: new Date()
    })
  }
  memo.delete(key)
}
