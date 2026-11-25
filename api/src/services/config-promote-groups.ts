import { CONFIG_TABLES } from './config-inventory.js'
import { RESTORE_EXCLUDED } from './config-restore.js'

/**
 * Hub config promotion (idea 30): the kinds of configuration an operator promotes from one
 * environment of an app to another, as groups of config tables. Pure; read by the Hub (the plan
 * form) and by the app (which tables a request may name). Every table is a CONFIG table
 * (config-inventory) that a restore may write (not RESTORE_EXCLUDED): the group test pins it.
 *
 * Not offered on purpose:
 *  - the schema registry (nivaro_collections / _fields / _relations): its rows describe database
 *    columns a config copy cannot create — schema moves with the app's release or a blueprint;
 *  - people, grants to people other than owner-group members (User Scopes), personal choices;
 *  - per-environment tables (the environments registry, settings overrides, sign-in providers):
 *    the target's own keep rules refuse them anyway.
 */

export interface ConfigGroup {
  key: string
  label: string
  hint: string
  tables: readonly string[]
}

export const CONFIG_PROMOTION_GROUPS: readonly ConfigGroup[] = [
  {
    key: 'layouts',
    label: 'Forms and layouts',
    hint: 'Record forms, their sections, field placement, templates, linked sections and field rules.',
    tables: [
      'nivaro_collection_layouts',
      'nivaro_layout_field_assignments',
      'nivaro_layout_templates',
      'nivaro_layout_section_links',
      'nivaro_field_groups',
      'nivaro_field_rules'
    ]
  },
  {
    key: 'flows',
    label: 'Flows',
    hint: 'Automations and their steps. Step addresses, headers and secrets stay as this environment has them; a flow new here arrives switched off.',
    tables: ['nivaro_flows', 'nivaro_flow_operations', 'nivaro_flow_versions']
  },
  {
    key: 'payload_templates',
    label: 'Payload templates',
    hint: 'Partner payload templates, their published versions and drafts. Body secrets never travel.',
    tables: [
      'nivaro_payload_templates',
      'nivaro_payload_template_versions',
      'nivaro_payload_template_drafts'
    ]
  },
  {
    key: 'managed_procedures',
    label: 'Managed procedures',
    hint: 'App-managed stored procedures: the definitions are copied, then each changed one is deployed into this environment’s database.',
    tables: ['nivaro_managed_procedures', 'nivaro_managed_procedure_versions']
  },
  {
    key: 'pipelines',
    label: 'Pipelines',
    hint: 'Workflow templates, steps, moves, bindings, owner dimensions and owner groups (members only when they are active here).',
    tables: [
      'nivaro_workflow_templates',
      'nivaro_workflow_states',
      'nivaro_workflow_transitions',
      'nivaro_workflow_bindings',
      'nivaro_workflow_template_versions',
      'nivaro_owner_matrix_versions',
      'nivaro_pipeline_owner_dimensions',
      'nivaro_pipeline_owner_groups',
      'nivaro_pipeline_owner_group_users',
      'nivaro_pipeline_owner_group_teams'
    ]
  },
  {
    key: 'roles',
    label: 'Roles and policies',
    hint: 'Roles and their permission policies. People and their role assignments never travel.',
    tables: ['nivaro_roles', 'nivaro_policies']
  },
  {
    key: 'settings',
    label: 'Settings (no secrets)',
    hint: 'Product settings that are the same everywhere. Where this environment sends mail, its keys, storage, sign-in and switches stay as they are here.',
    tables: ['nivaro_settings']
  }
]

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

/** Every table a promotion may name: the groups' tables (all CONFIG, none excluded). */
export function promotableTables(): Set<string> {
  const config = new Set(CONFIG_TABLES)
  return new Set(
    CONFIG_PROMOTION_GROUPS.flatMap((g) => g.tables).filter(
      (t) => config.has(t) && !RESTORE_EXCLUDED[t]
    )
  )
}

/** The group a table belongs to (for the plan's headings). */
export function groupOfTable(table: string): ConfigGroup | null {
  return CONFIG_PROMOTION_GROUPS.find((g) => g.tables.includes(table)) ?? null
}
