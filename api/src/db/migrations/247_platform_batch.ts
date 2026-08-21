import type { Knex } from 'knex'

/**
 * Platform & DX batch:
 *  - nivaro_mail_templates      — DB override layer above the file mail
 *                                 templates (#18); absent row = file default
 *  - nivaro_access_requests     — collection-level access requests (#55)
 *  - nivaro_settings branding   — logo, login copy (#21)
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_mail_templates'))) {
    await knex.schema.createTable('nivaro_mail_templates', (t) => {
      t.increments('id').primary()
      t.string('name', 120).notNullable().unique()
      t.text('body').notNullable()
      t.uuid('updated_by').nullable().references('id').inTable('nivaro_users')
      t.datetime('updated_at').notNullable().defaultTo(knex.fn.now())
    })
  }

  if (!(await knex.schema.hasTable('nivaro_access_requests'))) {
    await knex.schema.createTable('nivaro_access_requests', (t) => {
      t.increments('id').primary()
      t.uuid('user').notNullable().references('id').inTable('nivaro_users')
      t.string('collection', 255).nullable()
      t.string('route', 500).nullable()
      t.string('note', 1000).nullable()
      t.string('status', 20).notNullable().defaultTo('pending') // pending | granted | denied
      t.uuid('resolved_by').nullable()
      t.datetime('resolved_at').nullable()
      t.datetime('created_at').notNullable().defaultTo(knex.fn.now())
      t.index(['status'])
    })
  }

  const brandCols: Array<[string, (t: Knex.AlterTableBuilder) => void]> = [
    ['brand_logo', (t) => t.uuid('brand_logo').nullable()],
    ['brand_login_title', (t) => t.string('brand_login_title', 200).nullable()],
    ['brand_login_message', (t) => t.string('brand_login_message', 1000).nullable()]
  ]
  for (const [col, add] of brandCols) {
    if (!(await knex.schema.hasColumn('nivaro_settings', col))) {
      await knex.schema.alterTable('nivaro_settings', add)
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_mail_templates')
  await knex.schema.dropTableIfExists('nivaro_access_requests')
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('brand_logo')
    t.dropColumn('brand_login_title')
    t.dropColumn('brand_login_message')
  })
}
