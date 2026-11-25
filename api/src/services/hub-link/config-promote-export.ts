import { hashRow, type SnapshotRow } from '../config-inventory.js'
import { SETTINGS_PROMOTED } from '../config-promote-groups.js'
import { exportStepOptions, exportTriggerOptions } from './config-promote-secrets.js'

/**
 * Hub config promotion — the export filter: what each promotable column becomes when it leaves
 * the source (and again when it arrives: the target applies the same filter before it diffs).
 * Every column of every promotable table is listed with its rule; a column not listed is dropped
 * (fail closed), and the guard test fails on a real column that has no rule, so a migration that
 * adds a column to a promotable table needs a decision here.
 *
 *   carry     the value travels as is (plain config, no ids, no secrets)
 *   ref       an id the map rewrites to the target's id of the same thing (config-promote-map)
 *   audit     who / when (created_by, updated_at …): never carried; the target keeps its own
 *   deploy    another environment's deploy record: never carried
 *   history   a version number / hash of history that stays per environment
 *   steps     flow step options: the outbound part and every nested secret stripped
 *   trigger   flow trigger options: the webhook inbound-auth group and every nested secret stripped
 *   template  a payload body / lookup template: placeholders name body secrets, values never in it
 *   policy    permission JSON (filters by field name): carried as written
 *   settings  only SETTINGS_PROMOTED columns (no secrets, no ids)
 */

export type ColumnRule =
  | 'carry'
  | 'ref'
  | 'audit'
  | 'deploy'
  | 'history'
  | 'steps'
  | 'trigger'
  | 'template'
  | 'policy'

export const COLUMN_RULES: Record<string, Record<string, ColumnRule>> = {
  nivaro_flows: {
    id: 'ref',
    name: 'carry',
    description: 'carry',
    status: 'carry',
    trigger: 'carry',
    trigger_options: 'trigger',
    accountability: 'carry',
    shadow_mode: 'carry',
    created_at: 'audit',
    updated_at: 'audit'
  },
  nivaro_flow_operations: {
    id: 'ref',
    flow: 'ref',
    name: 'carry',
    key: 'carry',
    type: 'carry',
    position_x: 'carry',
    position_y: 'carry',
    options: 'steps',
    resolve: 'ref',
    reject: 'ref',
    created_at: 'audit'
  },
  nivaro_payload_templates: {
    id: 'ref',
    key: 'carry',
    label: 'carry',
    description: 'carry',
    collection: 'carry',
    endpoint_path: 'carry',
    external_api: 'ref',
    locked_keys: 'carry',
    lookups: 'template',
    published_body: 'template',
    published_mode: 'carry',
    published_version: 'history',
    published_at: 'audit',
    published_by: 'audit',
    default_hash: 'history',
    owner: 'audit',
    created_at: 'audit',
    updated_at: 'audit'
  },
  nivaro_managed_procedures: {
    id: 'ref',
    name: 'carry',
    body: 'carry',
    description: 'carry',
    dropped_at: 'carry',
    body_hash: 'history',
    version: 'history',
    deployed_hash: 'deploy',
    deployed_at: 'deploy',
    deployed_by: 'deploy',
    owner: 'audit',
    updated_at: 'audit',
    updated_by: 'audit'
  },
  nivaro_roles: {
    id: 'ref',
    name: 'carry',
    description: 'carry',
    admin_access: 'carry',
    app_access: 'carry',
    ui_permissions: 'policy',
    workspace: 'ref',
    created_at: 'audit',
    updated_at: 'audit'
  },
  nivaro_policies: {
    id: 'ref',
    role: 'ref',
    collection: 'carry',
    action: 'carry',
    fields: 'policy',
    permissions: 'policy',
    presets: 'policy',
    row_filter: 'policy',
    validation: 'policy',
    created_at: 'audit'
  }
}

const CARRIED: ReadonlySet<ColumnRule> = new Set([
  'carry',
  'ref',
  'steps',
  'trigger',
  'template',
  'policy'
])

/** Exported for the guard test: the rule of a column (settings: SETTINGS_PROMOTED + id). */
export function ruleOf(table: string, column: string): ColumnRule | null {
  if (table === 'nivaro_settings')
    return column === 'id' ? 'ref' : SETTINGS_PROMOTED.includes(column) ? 'carry' : null
  return COLUMN_RULES[table]?.[column] ?? null
}

export interface ExportResult {
  rows: Record<string, SnapshotRow>
  /** Per row key: the step option keys taken off (a step that needs this environment's values). */
  stripped: Record<string, string[]>
}

/** One table's rows through the export filter. Pure. */
export function exportTable(table: string, rows: Record<string, SnapshotRow>): ExportResult {
  const out: Record<string, SnapshotRow> = {}
  const stripped: Record<string, string[]> = {}
  for (const [key, row] of Object.entries(rows)) {
    const data: Record<string, unknown> = {}
    for (const [c, v] of Object.entries(row.data)) {
      const rule = ruleOf(table, c)
      if (!rule || !CARRIED.has(rule)) continue
      if (rule === 'steps') {
        const e = exportStepOptions(v)
        data[c] = e.options
        if (e.stripped.length) stripped[key] = e.stripped
      } else if (rule === 'trigger') data[c] = exportTriggerOptions(v)
      else data[c] = v
    }
    out[key] = { hash: hashRow(data), data }
  }
  return { rows: out, stripped }
}
