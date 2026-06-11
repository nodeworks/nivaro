import type { Knex } from 'knex'

/**
 * Restores junction_field values from the original Directus relations export.
 *
 * In Directus's data model, BOTH rows in an M2M pair have junction_field set —
 * each pointing to the FK on the other side of the junction table.
 * Migrations 073/074 were based on a wrong assumption and may have cleared these.
 *
 * This migration is the authoritative fix: it sets junction_field based on
 * (many_collection, many_field) lookups derived from the original source data.
 * Rows not in the list are left unchanged. Idempotent.
 */

// [many_collection, many_field, correct_junction_field]
const JUNCTION_FIELD_FIXES: [string, string, string][] = [
  ['project_sub_types_junction', 'project_sub_type', 'project'],
  ['project_sub_types_junction', 'project', 'project_sub_type'],
  ['project_type_division_junction', 'project_type', 'division'],
  ['project_type_division_junction', 'division', 'project_type'],
  ['workflow_purchase_orders_junction', 'workflow', 'purchase_order'],
  ['workflow_purchase_orders_junction', 'purchase_order', 'workflow'],
  ['project_categories_junction', 'project', 'category'],
  ['project_categories_junction', 'category', 'project'],
  ['project_divisions_junction', 'division', 'project'],
  ['project_divisions_junction', 'project', 'division'],
  ['project_funding_years_junction', 'funding_year', 'project'],
  ['project_funding_years_junction', 'project', 'funding_year'],
  ['user_user_roles_junction', 'user_id', 'user_role_id'],
  ['user_user_roles_junction', 'user_role_id', 'user_id'],
  ['project_sub_types_project_types_junction', 'project_type', 'project_sub_type'],
  ['project_sub_types_project_types_junction', 'project_sub_type', 'project_type'],
  ['project_regions_junction', 'region', 'project'],
  ['project_regions_junction', 'project', 'region'],
  ['location_regions_junction', 'region', 'location'],
  ['location_regions_junction', 'location', 'region'],
  ['project_types_categories_junction', 'project_type', 'category'],
  ['project_types_categories_junction', 'category', 'project_type'],
  ['junction_directus_users_divisions', 'divisions_id', 'directus_users_id'],
  ['junction_directus_users_divisions', 'directus_users_id', 'divisions_id'],
  ['junction_directus_users_project_types', 'project_types_id', 'directus_users_id'],
  ['junction_directus_users_project_types', 'directus_users_id', 'project_types_id'],
  ['junction_directus_users_regions', 'regions_id', 'directus_users_id'],
  ['junction_directus_users_regions', 'directus_users_id', 'regions_id'],
  ['junction_directus_users_projects', 'projects_id', 'directus_users_id'],
  ['junction_directus_users_projects', 'directus_users_id', 'projects_id'],
  ['junction_directus_users_divisions_1', 'divisions_id', 'directus_users_id'],
  ['junction_directus_users_divisions_1', 'directus_users_id', 'divisions_id'],
  ['junction_directus_users_project_types_notification', 'project_types_id', 'directus_users_id'],
  ['junction_directus_users_project_types_notification', 'directus_users_id', 'project_types_id'],
  ['junction_directus_users_divisions_notification', 'divisions_id', 'directus_users_id'],
  ['junction_directus_users_divisions_notification', 'directus_users_id', 'divisions_id'],
  ['junction_directus_users_regions_notification', 'regions_id', 'directus_users_id'],
  ['junction_directus_users_regions_notification', 'directus_users_id', 'regions_id'],
  ['junction_directus_users_projects_notification', 'projects_id', 'directus_users_id'],
  ['junction_directus_users_projects_notification', 'directus_users_id', 'projects_id'],
  ['junction_directus_users_workflow_states_notification', 'workflow_states_id', 'directus_users_id'],
  ['junction_directus_users_workflow_states_notification', 'directus_users_id', 'workflow_states_id'],
  ['junction_directus_users_project_types_owners', 'project_types_id', 'directus_users_id'],
  ['junction_directus_users_project_types_owners', 'directus_users_id', 'project_types_id'],
  ['junction_directus_users_projects_owners', 'projects_id', 'directus_users_id'],
  ['junction_directus_users_projects_owners', 'directus_users_id', 'projects_id'],
  ['junction_directus_users_regions_owners', 'regions_id', 'directus_users_id'],
  ['junction_directus_users_regions_owners', 'directus_users_id', 'regions_id'],
  ['junction_directus_users_workflow_states_owners', 'workflow_states_id', 'directus_users_id'],
  ['junction_directus_users_workflow_states_owners', 'directus_users_id', 'workflow_states_id'],
  ['junction_directus_activity_item_detail', 'directus_activity_id', 'item'],
  ['junction_directus_users_divisions_restricted', 'divisions_id', 'directus_users_id'],
  ['junction_directus_users_divisions_restricted', 'directus_users_id', 'divisions_id'],
  ['junction_directus_users_project_types_restricted', 'project_types_id', 'directus_users_id'],
  ['junction_directus_users_project_types_restricted', 'directus_users_id', 'project_types_id'],
  ['junction_directus_users_regions_restricted', 'regions_id', 'directus_users_id'],
  ['junction_directus_users_regions_restricted', 'directus_users_id', 'regions_id'],
  ['junction_directus_users_projects_restricted', 'projects_id', 'directus_users_id'],
  ['junction_directus_users_projects_restricted', 'directus_users_id', 'projects_id'],
  ['owners_directus_users', 'directus_users_id', 'owners_id'],
  ['owners_directus_users', 'owners_id', 'directus_users_id'],
  ['workflows_files', 'directus_files_id', 'workflows_id'],
  ['workflows_files', 'workflows_id', 'directus_files_id'],
  ['workflows_categories', 'categories_id', 'workflows_id'],
  ['workflows_categories', 'workflows_id', 'categories_id'],
  ['workflows_project_sub_types', 'project_sub_types_id', 'workflows_id'],
  ['workflows_project_sub_types', 'workflows_id', 'project_sub_types_id'],
  ['workflows_funding_years', 'funding_years_year', 'workflows_id'],
  ['workflows_funding_years', 'workflows_id', 'funding_years_year'],
  ['workflows_regions', 'regions_id', 'workflows_id'],
  ['workflows_regions', 'workflows_id', 'regions_id'],
  ['workflows_divisions', 'divisions_id', 'workflows_id'],
  ['workflows_divisions', 'workflows_id', 'divisions_id'],
  ['org_codes_regions', 'regions_id', 'org_codes_id'],
  ['org_codes_regions', 'org_codes_id', 'regions_id'],
  ['forecasts_funding_years', 'funding_years_id', 'forecasts_id'],
  ['forecasts_funding_years', 'forecasts_id', 'funding_years_id'],
  ['forecasts_divisions', 'divisions_id', 'forecasts_id'],
  ['forecasts_divisions', 'forecasts_id', 'divisions_id'],
  ['forecasts_project_types', 'project_types_id', 'forecasts_id'],
  ['forecasts_project_types', 'forecasts_id', 'project_types_id'],
  ['forecasts_regions', 'regions_id', 'forecasts_id'],
  ['forecasts_regions', 'forecasts_id', 'regions_id'],
  ['forecasts_project_sub_types', 'project_sub_types_id', 'forecasts_id'],
  ['forecasts_project_sub_types', 'forecasts_id', 'project_sub_types_id'],
  ['addendums_directus_files', 'directus_files_id', 'addendums_id'],
  ['addendums_directus_files', 'addendums_id', 'directus_files_id'],
  ['junction_directus_roles_permissions', 'permissions_id', 'directus_roles_id'],
  ['junction_directus_roles_permissions', 'directus_roles_id', 'permissions_id'],
  ['categories_project_types_categories_junction', 'project_types_categories_junction_id', 'categories_id'],
  ['deployment_part_types_project_types', 'project_types_id', 'deployment_part_types_id'],
  ['deployment_part_types_project_types', 'deployment_part_types_id', 'project_types_id'],
  ['deployment_types_project_types', 'project_types_id', 'deployment_types_id'],
  ['deployment_types_project_types', 'deployment_types_id', 'project_types_id'],
  ['units_funding_years', 'funding_years_id', 'units_id'],
  ['units_funding_years', 'units_id', 'funding_years_id'],
  ['vendors_locations', 'locations_id', 'vendors_id'],
  ['vendors_locations', 'vendors_id', 'locations_id'],
  ['divisions_nami_lookups', 'divisions_id', 'nami_lookups_id'],
  ['divisions_nami_lookups', 'nami_lookups_id', 'divisions_id'],
  ['regions_nami_lookups', 'nami_lookups_id', 'regions_id'],
  ['regions_nami_lookups', 'regions_id', 'nami_lookups_id'],
  ['nami_lookups_entity', 'nami_lookups_id', 'item'],
  ['junction_directus_users_projects_1', 'projects_id', 'directus_users_id'],
  ['junction_directus_users_projects_1', 'directus_users_id', 'projects_id'],
  ['junction_directus_users_contractor_tasks', 'contractor_tasks_id', 'directus_users_id'],
  ['junction_directus_users_contractor_tasks', 'directus_users_id', 'contractor_tasks_id'],
  ['po_file_queue_files', 'directus_files_id', 'po_file_queue_id'],
  ['po_file_queue_files', 'po_file_queue_id', 'directus_files_id'],
  ['supplier_unit_type_map_deployment_part_types', 'deployment_part_types_id', 'supplier_unit_type_map_id'],
  ['supplier_unit_type_map_deployment_part_types', 'supplier_unit_type_map_id', 'deployment_part_types_id'],
  ['supplier_unit_type_map_deployment_part_types_1', 'deployment_part_types_id', 'supplier_unit_type_map_id'],
  ['supplier_unit_type_map_deployment_part_types_1', 'supplier_unit_type_map_id', 'deployment_part_types_id'],
  ['inventory_request_files', 'directus_files_id', 'inventory_request_id'],
  ['inventory_request_files', 'inventory_request_id', 'directus_files_id'],
  ['inventory_request_owners_directus_users', 'directus_users_id', 'inventory_request_owners_id'],
  ['inventory_request_owners_directus_users', 'inventory_request_owners_id', 'directus_users_id'],
  ['junction_directus_users_funding_years', 'funding_years_id', 'directus_users_id'],
  ['junction_directus_users_funding_years', 'directus_users_id', 'funding_years_id'],
  ['cifa_items_project_types', 'project_types_id', 'cifa_items_id'],
  ['cifa_items_project_types', 'cifa_items_id', 'project_types_id'],
  ['cifa_items_project_types_1', 'project_types_id', 'cifa_items_id'],
  ['cifa_items_project_types_1', 'cifa_items_id', 'project_types_id'],
  ['fiber_jumper_lengths_fiber_jumper_connectors', 'fiber_jumper_connectors_id', 'fiber_jumper_lengths_id'],
  ['fiber_jumper_lengths_fiber_jumper_connectors', 'fiber_jumper_lengths_id', 'fiber_jumper_connectors_id'],
  ['attenuator_pad_db_levels_attenuator_pad_connectors', 'attenuator_pad_connectors_id', 'attenuator_pad_db_levels_id'],
  ['attenuator_pad_db_levels_attenuator_pad_connectors', 'attenuator_pad_db_levels_id', 'attenuator_pad_connectors_id'],
  ['inventory_request_directus_users', 'directus_users_id', 'inventory_request_id'],
  ['inventory_request_directus_users', 'inventory_request_id', 'directus_users_id'],
  ['cifa_item_favorites_warehouse_inventory', 'warehouse_inventory_id', 'cifa_item_favorites_id'],
  ['cifa_item_favorites_warehouse_inventory', 'cifa_item_favorites_id', 'warehouse_inventory_id'],
  ['locations_expenditure_orgs', 'locations_id', 'expenditure_orgs_id'],
  ['locations_org_codes_1', 'org_codes_id', 'locations_id'],
  ['locations_org_codes_1', 'locations_id', 'org_codes_id'],
  ['notes_directus_users', 'directus_users_id', 'notes_id'],
  ['notes_directus_users', 'notes_id', 'directus_users_id'],
  ['sow_id_templates_sow_ids', 'sow_ids_id', 'sow_id_templates_id'],
  ['sow_id_templates_sow_ids', 'sow_id_templates_id', 'sow_ids_id'],
  ['metro_e_fiber_jumper_lengths_metro_e_fiber_jumper_connectors', 'metro_e_fiber_jumper_connectors_id', 'metro_e_fiber_jumper_lengths_id'],
  ['metro_e_fiber_jumper_lengths_metro_e_fiber_jumper_connectors', 'metro_e_fiber_jumper_lengths_id', 'metro_e_fiber_jumper_connectors_id'],
]

export async function up(knex: Knex): Promise<void> {
  let updated = 0
  let skipped = 0

  for (const [many_collection, many_field, junction_field] of JUNCTION_FIELD_FIXES) {
    const row = await knex('nivaro_relations')
      .where({ many_collection, many_field })
      .first('id', 'junction_field')

    if (!row) { skipped++; continue }

    if (row.junction_field === junction_field) { skipped++; continue }

    await knex('nivaro_relations')
      .where({ id: row.id })
      .update({ junction_field })

    console.log(`[075] ${many_collection}.${many_field}: junction_field "${row.junction_field ?? 'null'}" → "${junction_field}"`)
    updated++
  }

  console.log(`[075_sync_junction_fields] Updated ${updated}, skipped ${skipped}`)
}

export async function down(_knex: Knex): Promise<void> {
  // Not reversible — original values are preserved above in JUNCTION_FIELD_FIXES
}
