import { SETTINGS_FROM_SOURCE } from './env-refresh/registry.js'

/**
 * Hub config promotion (idea 30): the kinds of configuration an operator promotes from one
 * environment of an app to another, as groups of config tables. Pure; read by the Hub (the plan
 * form) and by the app (which tables a request may name). Every table has a natural key and
 * reference map (services/hub-link/config-promote-map.ts): rows are matched by name or key and
 * every reference is rewritten to the target's id, never carried as the source's id.
 *
 * Not offered (yet), on purpose:
 *  - forms / layouts and pipelines: their rows reference roles, steps, people, widgets, PDF
 *    templates and each other by id inside JSON (visibility rules, owner groups, transition
 *    actions); matching all of those by name is not built, and a raw id is never carried;
 *  - version-history tables (flow, payload-template, managed-procedure, workflow and owner-matrix
 *    versions, payload drafts): history belongs to each environment;
 *  - the schema registry, people, User Scopes, per-environment tables.
 */

export interface ConfigGroup {
  key: string
  label: string
  hint: string
  tables: readonly string[]
}

export const CONFIG_PROMOTION_GROUPS: readonly ConfigGroup[] = [
  {
    key: 'flows',
    label: 'Flows',
    hint: 'Automations and their steps, matched by flow name and step key. Step addresses, headers and secrets, and a webhook’s inbound auth, stay as this environment has them. A flow new here — or one that gains a step needing this environment’s address — arrives switched off.',
    tables: ['nivaro_flows', 'nivaro_flow_operations']
  },
  {
    key: 'payload_templates',
    label: 'Payload templates',
    hint: 'Partner payload templates, matched by key; their external API is matched by name. Body secrets never travel; history stays per environment.',
    tables: ['nivaro_payload_templates']
  },
  {
    key: 'managed_procedures',
    label: 'Managed procedures',
    hint: 'App-managed stored procedures, matched by name: each changed one is saved and deployed through its own writer (a new version here), never copied with another environment’s deploy record.',
    tables: ['nivaro_managed_procedures']
  },
  {
    key: 'roles',
    label: 'Roles and policies',
    hint: 'Roles matched by name and their permission policies. People and their role assignments never travel.',
    tables: ['nivaro_roles', 'nivaro_policies']
  },
  {
    key: 'settings',
    label: 'Settings (no secrets)',
    hint: 'Product settings that are the same everywhere and name nothing by id. Mail, keys, storage, sign-in, switches and role choices stay as they are here.',
    tables: ['nivaro_settings']
  }
]

/**
 * nivaro_settings columns a promotion carries: the env-refresh "follows the source" list minus
 * every column that names roles, widgets, rooms, tools, files (brand_logo = a file id) or records
 * (sla_zone_map = record id → time zone) by id: they stay on the target.
 */
const SETTINGS_ID_COLUMN =
  /role|^command_center$|^mcp_tools$|^dashboard_headline$|^chat_general$|^brand_logo$|^sla_zone_map$/
export const SETTINGS_PROMOTED: readonly string[] = SETTINGS_FROM_SOURCE.filter(
  (c) => c !== 'updated_at' && !SETTINGS_ID_COLUMN.test(c)
)

const BY_KEY = new Map(CONFIG_PROMOTION_GROUPS.map((g) => [g.key, g]))

export function isConfigGroupKey(v: unknown): v is string {
  return typeof v === 'string' && BY_KEY.has(v)
}

/** The tables of these groups, in group order, each once. Unknown keys are ignored. */
export function tablesForGroups(keys: readonly string[]): string[] {
  const out: string[] = []
  for (const k of keys)
    for (const t of BY_KEY.get(k)?.tables ?? []) if (!out.includes(t)) out.push(t)
  return out
}

/** Every table a promotion may name. */
export function promotableTables(): Set<string> {
  return new Set(CONFIG_PROMOTION_GROUPS.flatMap((g) => g.tables))
}

/** The group a table belongs to (for the plan's headings). */
export function groupOfTable(table: string): ConfigGroup | null {
  return CONFIG_PROMOTION_GROUPS.find((g) => g.tables.includes(table)) ?? null
}
