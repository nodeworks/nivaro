import type { Knex } from 'knex'

/**
 * Generic staged imports.
 *
 * The EFP port hard-coded two naming conventions — a `staging_<entity>` table
 * and an `import_<entity>` procedure — and ran off EFP's own `import_queue`
 * table. Both become DATA here:
 *
 *   nivaro_import_definitions  what can be imported, and where it lands
 *   nivaro_import_queue        runs of those definitions
 *
 * So a deployment with different table/procedure names (or no procedures at
 * all) configures rows instead of matching a convention. EFP's 54 procs are
 * seeded as definitions below, and its 9k queue rows are migrated across with
 * `legacy_id` provenance — the same pattern used for the activity/revision
 * import.
 */

export async function up(knex: Knex): Promise<void> {
  const hasDefs = await knex.schema.hasTable('nivaro_import_definitions')
  if (!hasDefs) {
    await knex.schema.createTable('nivaro_import_definitions', (t) => {
      t.increments('id').primary()
      // Stable slug used by the API and by queue rows.
      t.string('key', 100).notNullable().unique()
      t.string('label', 255)
      t.text('description')
      // Where cleaned rows are loaded. Defaults to `staging_<key>` at runtime
      // when null, which is what every EFP definition relies on.
      t.string('staging_table', 255)
      // Optional: run after the staging load. Null = load only, no procedure.
      t.string('procedure', 255)
      // 'bulk' (file share + BULK INSERT) or 'insert' (batched inserts).
      // Null = fall back to the deployment default.
      t.string('loader', 20)
      // JSON array of accepted extensions; null = csv + xlsx.
      t.text('file_types')
      t.boolean('is_active').notNullable().defaultTo(true)
      t.integer('sort').notNullable().defaultTo(0)
      t.timestamp('created_at').defaultTo(knex.fn.now())
    })
  }

  const hasQueue = await knex.schema.hasTable('nivaro_import_queue')
  if (!hasQueue) {
    await knex.schema.createTable('nivaro_import_queue', (t) => {
      t.increments('id').primary()
      // FK is NO ACTION per the MSSQL multi-cascade rule; `import_key` is
      // denormalised so run history survives a definition being deleted.
      t.integer('definition')
        .references('id')
        .inTable('nivaro_import_definitions')
        .onDelete('NO ACTION')
        .onUpdate('NO ACTION')
      t.string('import_key', 100).notNullable()
      t.string('status', 20).notNullable().defaultTo('queued')
      t.integer('sort').notNullable().defaultTo(0)
      t.uuid('file')
      t.integer('row_count')
      t.integer('duration')
      t.text('logs')
      t.timestamp('started_at')
      t.timestamp('finished_at')
      t.uuid('created_by')
      t.timestamp('created_at').defaultTo(knex.fn.now())
      t.timestamp('updated_at')
      // Provenance for rows carried over from a legacy import_queue.
      t.integer('legacy_id')
    })
    // The worker polls "anything running?" then "next queued by sort" on every
    // tick — without this it table-scans a growing history table every 10s.
    await knex.raw(
      'CREATE INDEX idx_import_queue_status_sort ON nivaro_import_queue (status, sort, id)'
    )
    await knex.raw(
      `CREATE UNIQUE INDEX idx_import_queue_legacy ON nivaro_import_queue (legacy_id) WHERE legacy_id IS NOT NULL`
    )
  }

  // ── Seed definitions from any import_<x> procedures already in the database.
  // Nivaro ships to deployments that have none; this is a no-op there.
  const procs = (await knex.raw(
    `SELECT name FROM sys.procedures WHERE name LIKE 'import[_]%'`
  )) as Array<{ name: string }>
  const procList = Array.isArray(procs) ? procs : []
  for (const p of procList) {
    const key = p.name.replace(/^import_/, '')
    const exists = await knex('nivaro_import_definitions').where({ key }).first()
    if (exists) continue
    await knex('nivaro_import_definitions').insert({
      key,
      label: key
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '),
      staging_table: `staging_${key}`,
      procedure: p.name,
      is_active: true
    })
  }

  // ── Carry over an existing legacy queue, if this deployment has one.
  const hasLegacy = await knex.schema.hasTable('import_queue')
  if (!hasLegacy) return

  const defs = await knex('nivaro_import_definitions').select('id', 'key')
  const defByKey = new Map(defs.map((d) => [d.key as string, d.id as number]))

  // Batched: EFP's table is ~9k rows and MSSQL caps bound parameters at ~2100.
  const BATCH = 200
  let offset = 0
  for (;;) {
    const rows = await knex('import_queue').orderBy('id').limit(BATCH).offset(offset)
    if (rows.length === 0) break
    offset += rows.length

    const payload = rows
      .filter((r) => r.entity_type)
      .map((r) => ({
        definition: defByKey.get(String(r.entity_type)) ?? null,
        import_key: String(r.entity_type),
        // Legacy used 'canceled'; keep it rather than inventing a mapping.
        status: String(r.status ?? 'completed'),
        sort: Number(r.sort ?? 0),
        file: r.file ?? null,
        row_count: r.row_count ?? null,
        duration: r.duration ?? null,
        logs: r.logs ?? null,
        finished_at: r.finished_at ?? null,
        created_by: r.user_created ?? null,
        created_at: r.date_created ?? null,
        updated_at: r.date_updated ?? null,
        legacy_id: r.id
      }))
    if (payload.length === 0) continue

    // Re-runnable: skip anything already carried over.
    const ids = payload.map((p) => p.legacy_id)
    const already = new Set(
      (await knex('nivaro_import_queue').whereIn('legacy_id', ids).pluck('legacy_id')).map(Number)
    )
    const fresh = payload.filter((p) => !already.has(Number(p.legacy_id)))
    if (fresh.length > 0) {
      for (let i = 0; i < fresh.length; i += 50) {
        await knex('nivaro_import_queue').insert(fresh.slice(i, i + 50))
      }
    }
  }

  // A run left 'running' by the old extension would block the new worker
  // forever — nothing is actually executing after a cutover.
  await knex('nivaro_import_queue')
    .where('status', 'running')
    .update({ status: 'error', logs: 'Interrupted by migration to nivaro_import_queue' })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_import_queue')
  await knex.schema.dropTableIfExists('nivaro_import_definitions')
}
