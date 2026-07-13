import type { Knex } from 'knex'

/**
 * Error tracking into nivaro_issues:
 *  - source: 'manual' (default) | 'server' | 'client'
 *  - details: message/stack/route context (nvarchar max)
 *  - fingerprint: sha256 of source+route+message for dedupe
 *  - occurrence_count / last_seen_at: repeat errors bump one row instead of
 *    flooding the table
 *  - raised_by becomes nullable: server 5xx errors may have no authenticated
 *    user attached
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_issues', (t) => {
    t.string('source', 20).notNullable().defaultTo('manual')
    t.text('details')
    t.string('fingerprint', 64)
    t.integer('occurrence_count').notNullable().defaultTo(1)
    t.datetime('last_seen_at')
  })
  // MSSQL: drop FK before altering nullability, then re-add (NO ACTION per repo rule)
  await knex.raw(`
    DECLARE @fk sysname;
    SELECT @fk = fk.name FROM sys.foreign_keys fk
    JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
    WHERE OBJECT_NAME(fk.parent_object_id) = 'nivaro_issues' AND c.name = 'raised_by';
    IF @fk IS NOT NULL EXEC('ALTER TABLE nivaro_issues DROP CONSTRAINT ' + @fk);
  `)
  await knex.raw('ALTER TABLE nivaro_issues ALTER COLUMN raised_by uniqueidentifier NULL')
  await knex.raw(`
    ALTER TABLE nivaro_issues ADD CONSTRAINT nivaro_issues_raised_by_fk
    FOREIGN KEY (raised_by) REFERENCES nivaro_users(id)
    ON DELETE NO ACTION ON UPDATE NO ACTION
  `)
  // Filtered index for the dedupe lookup (fingerprint set only on tracked errors)
  await knex.raw(`
    CREATE INDEX ix_nivaro_issues_fingerprint ON nivaro_issues (fingerprint)
    WHERE fingerprint IS NOT NULL
  `)
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX ix_nivaro_issues_fingerprint ON nivaro_issues')
  await knex.schema.alterTable('nivaro_issues', (t) => {
    t.dropColumn('source')
    t.dropColumn('details')
    t.dropColumn('fingerprint')
    t.dropColumn('occurrence_count')
    t.dropColumn('last_seen_at')
  })
}
