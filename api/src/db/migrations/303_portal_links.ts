import type { Knex } from 'knex'

/**
 * Where email links land: a headless frontend ("portal") base URL and its
 * route map, so emails can send non-admin users to the app they actually use
 * (services/app-links.ts). Extensions may register the same through
 * ctx.links.register; settings win when both exist.
 */
export async function up(knex: Knex): Promise<void> {
  const t = 'nivaro_settings'
  if (!(await knex.schema.hasColumn(t, 'portal_url'))) {
    await knex.schema.alterTable(t, (tb) => {
      tb.string('portal_url', 500).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(t, 'portal_routes'))) {
    await knex.schema.alterTable(t, (tb) => {
      tb.text('portal_routes').nullable() // JSON {kind: '/path/{param}'}
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const t = 'nivaro_settings'
  for (const c of ['portal_url', 'portal_routes']) {
    if (await knex.schema.hasColumn(t, c)) {
      await knex.schema.alterTable(t, (tb) => {
        tb.dropColumn(c)
      })
    }
  }
}
