import type { Knex } from 'knex'

/**
 * Nivaro Hub: where a Docker stack keeps its files (Hub agent 0.2.2), on
 * nivaro_hub_stack_settings:
 *
 *   uploads_folder   an EXISTING folder under the agent's NFS export the stack uses as its
 *                    uploads instead of <stack>/uploads (relative path; the agent never creates,
 *                    changes or deletes it)
 *   files_subfolder  where the files sit inside the uploads volume: STORAGE_LOCAL_ROOT becomes
 *                    /app/uploads/<files_subfolder>
 *   run_as           'app' = the app services run as uid 1000 from the start (NFS with root
 *                    squash); null = the image decides
 *
 * Created everywhere, used only with HUB=on; efp-ops promote SKIP (the table already is).
 * Nullable, each added only when missing; down drops what is there.
 */
const TABLE = 'nivaro_hub_stack_settings'

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, 'uploads_folder'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('uploads_folder', 200).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'files_subfolder'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('files_subfolder', 200).nullable()
    })
  }
  if (!(await knex.schema.hasColumn(TABLE, 'run_as'))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.string('run_as', 16).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(TABLE))) return
  for (const col of ['run_as', 'files_subfolder', 'uploads_folder']) {
    if (await knex.schema.hasColumn(TABLE, col)) {
      await knex.schema.alterTable(TABLE, (t) => t.dropColumn(col))
    }
  }
}
