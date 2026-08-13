import type { Knex } from 'knex'

/**
 * A user-FK column on the bound record whose user counts as an owner.
 *
 * Owner groups answer "who owns records LIKE this one", which leaves a record
 * whose dimensions match no group with nobody at all — it disappears from every
 * "my work" view and no one is accountable for it. Real workflows fall back to a
 * person the record already names (its creator, its requester), and the legacy
 * system this replaces did exactly that, which is why its queues showed an owner
 * for almost every record while ours showed none for hundreds.
 *
 * Held on the binding rather than the template because the column name belongs
 * to the COLLECTION (user_created here, creator elsewhere), and one template can
 * be bound to several. NULL = no fallback, the historic behaviour.
 */
export async function up(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_workflow_bindings', 'owner_fallback_field')
  if (!has) {
    await knex.schema.alterTable('nivaro_workflow_bindings', (t) => {
      t.string('owner_fallback_field', 255).nullable()
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  const has = await knex.schema.hasColumn('nivaro_workflow_bindings', 'owner_fallback_field')
  if (has) {
    await knex.schema.alterTable('nivaro_workflow_bindings', (t) => {
      t.dropColumn('owner_fallback_field')
    })
  }
}
