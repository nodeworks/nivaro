import type { Knex } from 'knex'

// Named MCP tools (#2464): the custom queries and flows an administrator exposes to MCP
// clients as tools of their own, with the query's (or the tool's declared) params as the
// input schema. One JSON text column on the settings row — instance config that travels
// with nivaro_settings; NULL = none. services/mcp-tools.ts owns the shape.
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_settings', 'mcp_tools'))) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.text('mcp_tools').nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_settings', 'mcp_tools')) {
    await knex.schema.alterTable('nivaro_settings', (t) => {
      t.dropColumn('mcp_tools')
    })
  }
}
