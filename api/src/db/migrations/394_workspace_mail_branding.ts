import type { Knex } from 'knex'

/**
 * Mail branding per workspace (#1463): the email chrome (logo, accent colour,
 * sender display name, footer line) a workspace's emails carry. Every column is
 * NULL = "use the instance branding" — a workspace that only sets a colour keeps
 * the instance logo. Read by services/mail-branding.ts; nivaro_workspaces is
 * already COPY-classified in config-inventory, so nothing moves there.
 */
const TABLE = 'nivaro_workspaces'

const COLUMNS: Array<{ name: string; length: number }> = [
  // A public https URL or a small data URI a mail client can fetch without signing in.
  { name: 'mail_logo', length: 1000 },
  // #rrggbb accent for the header rule and the brand mark.
  { name: 'mail_color', length: 20 },
  // The From display name and the "Sent by …" footer name.
  { name: 'mail_sender_name', length: 200 },
  // A plain-text line under the standard footer sentence.
  { name: 'mail_footer', length: 2000 }
]

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  for (const col of COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, col.name)) continue
    await knex.schema.alterTable(TABLE, (t) => {
      t.string(col.name, col.length).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  for (const col of COLUMNS) {
    if (!(await knex.schema.hasColumn(TABLE, col.name))) continue
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropColumn(col.name)
    })
  }
}
