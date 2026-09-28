import type { Knex } from 'knex'

/**
 * One source for the human id of a record (#776): `nivaro_collections.
 * friendly_id_field` names the column notifications, mail, event paths,
 * alias URLs and chat rooms print for a record ("CM26-79811", never 371367).
 * Seeded from what the readers used until now — the chat entity-room
 * registry's match_field, else the first URL alias field — so nothing
 * changes on the wire the day it lands. Additive, nullable.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('nivaro_collections', 'friendly_id_field'))) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.string('friendly_id_field', 255).nullable()
    })
  }
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/
  const seed = new Map<string, string>()
  if (await knex.schema.hasTable('nivaro_chat_room_types')) {
    const types = (await knex('nivaro_chat_room_types')
      .where({ is_active: true })
      .select('collection', 'match_field')) as Array<{
      collection: string
      match_field: string | null
    }>
    for (const t of types) {
      if (
        t.match_field &&
        t.match_field !== 'id' &&
        ident.test(t.match_field) &&
        !seed.has(t.collection)
      ) {
        seed.set(t.collection, t.match_field)
      }
    }
  }
  const cols = (await knex('nivaro_collections').select(
    'collection',
    'url_alias_fields',
    'friendly_id_field'
  )) as Array<{
    collection: string
    url_alias_fields: string | null
    friendly_id_field: string | null
  }>
  for (const c of cols) {
    if (c.friendly_id_field) continue
    let field = seed.get(c.collection) ?? null
    if (!field && c.url_alias_fields) {
      try {
        const list = JSON.parse(c.url_alias_fields) as unknown
        if (Array.isArray(list) && typeof list[0] === 'string' && ident.test(list[0]))
          field = list[0]
      } catch {
        /* not a list */
      }
    }
    if (field) {
      await knex('nivaro_collections')
        .where({ collection: c.collection })
        .update({ friendly_id_field: field })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('nivaro_collections', 'friendly_id_field')) {
    await knex.schema.alterTable('nivaro_collections', (t) => {
      t.dropColumn('friendly_id_field')
    })
  }
}
