import { db } from '../../../db/index.js'
import { ConfigPromotionError } from './types.js'

/**
 * Hub config promotion switch. Promotion has not yet run against a real pair of SQL Server
 * environments, so it is OFF until an administrator turns it on (the same rule as the data care
 * switches: refreshes, drills, rehearsals). While it is off, a new plan and an apply are refused
 * (409 CONFIG_PROMOTION_OFF); "Check the target" and the undo of a promotion that already ran
 * stay allowed, so nothing already written is ever stranded.
 *
 * Stored as one JSON object in nivaro_extension_settings ('nivaro-core', 'hub_config_promotion');
 * a row that cannot be read is off.
 */

export const SWITCH_EXT = 'nivaro-core'
export const SWITCH_KEY = 'hub_config_promotion'

export interface ConfigSwitch {
  config_promotion: boolean
}

export const SWITCH_NOTICE =
  'Config promotion is off until it has been tried on a staging pair. An administrator can turn it on in Hub settings.'

export async function readConfigSwitch(): Promise<ConfigSwitch> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: SWITCH_EXT, key: SWITCH_KEY })
      .first('value')) as { value: string | null } | undefined
    const v = JSON.parse(row?.value ?? '{}') as Record<string, unknown>
    return { config_promotion: v.config_promotion === true }
  } catch {
    return { config_promotion: false }
  }
}

export async function configPromotionOn(): Promise<boolean> {
  return (await readConfigSwitch()).config_promotion
}

export async function saveConfigSwitch(
  body: Record<string, unknown>,
  by: string | null
): Promise<ConfigSwitch> {
  if (typeof body.config_promotion !== 'boolean')
    throw new ConfigPromotionError('BAD_SWITCH', 'config_promotion must be true or false.', 400)
  const next: ConfigSwitch = { config_promotion: body.config_promotion }
  const value = JSON.stringify(next)
  const updated_by = by && /^[0-9a-f-]{36}$/i.test(by) ? by : null
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: SWITCH_EXT, key: SWITCH_KEY })
    .first('id')) as { id: number } | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date(), updated_by })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: SWITCH_EXT,
      key: SWITCH_KEY,
      value,
      updated_at: new Date(),
      updated_by
    })
  return next
}

/** Refuses (409 CONFIG_PROMOTION_OFF) a new plan or an apply while the switch is off. */
export function switchedOff(): ConfigPromotionError {
  return new ConfigPromotionError('CONFIG_PROMOTION_OFF', SWITCH_NOTICE, 409)
}
