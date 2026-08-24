import type { Knex } from 'knex'

// Reports/Dashboards/Pages sprint: widget-scoped report subscriptions (#381)
// and role-gated page-builder pages (#167).
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_report_subscriptions', 'widget_id'))) {
    await knex.schema.alterTable('nivaro_report_subscriptions', (t) => {
      // No FK — widgets are bulk-replaced by PUT /:id/widgets (same reason
      // nivaro_report_alerts.widget has none). NULL = whole-report digest.
      t.string('widget_id', 36).nullable()
    })
  }
  if (!(await knex.schema.hasColumn('nivaro_pages', 'allowed_roles'))) {
    await knex.schema.alterTable('nivaro_pages', (t) => {
      // JSON array of role ids; NULL/empty = everyone (historic behavior).
      t.text('allowed_roles').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_report_subscriptions', 'widget_id')) {
    await knex.schema.alterTable('nivaro_report_subscriptions', (t) => t.dropColumn('widget_id'))
  }
  if (await knex.schema.hasColumn('nivaro_pages', 'allowed_roles')) {
    await knex.schema.alterTable('nivaro_pages', (t) => t.dropColumn('allowed_roles'))
  }
}
