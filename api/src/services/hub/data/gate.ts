import { db } from '../../../db/index.js'
import { DataError } from './types.js'

/**
 * Hub data care switches: refreshes, restore drills and move rehearsals each restore a database
 * on a live server, so they are OFF until an administrator turns them on — and the switch says
 * to do that only after a real restore drill on a staging server. Backups need no switch.
 *
 * Stored as one JSON object in nivaro_extension_settings ('nivaro-core', 'hub_data_care'); a
 * row that cannot be read is every switch off.
 */

export const GATE_EXT = 'nivaro-core'
export const GATE_KEY = 'hub_data_care'

export interface DataGate {
  refresh_enabled: boolean
  drill_enabled: boolean
  rehearsal_enabled: boolean
}

export const GATE_OFF: DataGate = {
  refresh_enabled: false,
  drill_enabled: false,
  rehearsal_enabled: false
}

export const GATE_WARNING =
  'Enable only after a real restore drill on a staging server: these restore databases on live servers.'

export async function readGate(): Promise<DataGate> {
  try {
    const row = (await db('nivaro_extension_settings')
      .where({ extension_id: GATE_EXT, key: GATE_KEY })
      .first('value')) as { value: string | null } | undefined
    const v = JSON.parse(row?.value ?? '{}') as Record<string, unknown>
    return {
      refresh_enabled: v.refresh_enabled === true,
      drill_enabled: v.drill_enabled === true,
      rehearsal_enabled: v.rehearsal_enabled === true
    }
  } catch {
    return { ...GATE_OFF }
  }
}

export async function saveGate(
  body: Record<string, unknown>,
  by: string | null
): Promise<DataGate> {
  const now = await readGate()
  const next: DataGate = { ...now }
  for (const k of Object.keys(GATE_OFF) as Array<keyof DataGate>) {
    if (!Object.hasOwn(body, k)) continue
    if (typeof body[k] !== 'boolean')
      throw new DataError('BAD_POLICY', `${k} must be true or false.`, 400)
    next[k] = body[k] as boolean
  }
  const value = JSON.stringify(next)
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: GATE_EXT, key: GATE_KEY })
    .first('id')) as { id: number } | undefined
  const updated_by = by && /^[0-9a-f-]{36}$/i.test(by) ? by : null
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date(), updated_by })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: GATE_EXT,
      key: GATE_KEY,
      value,
      updated_at: new Date(),
      updated_by
    })
  return next
}

const WORDS: Record<keyof DataGate, string> = {
  refresh_enabled: 'Refreshes',
  drill_enabled: 'Restore drills',
  rehearsal_enabled: 'Move rehearsals'
}

/** Refuses (409 FEATURE_OFF) unless the switch is on. */
export async function assertGate(k: keyof DataGate, gate?: DataGate): Promise<void> {
  const g = gate ?? (await readGate())
  if (!g[k])
    throw new DataError(
      'FEATURE_OFF',
      `${WORDS[k]} are switched off on this Hub. An administrator turns them on under Backups & data → Switches (${GATE_WARNING})`
    )
}
