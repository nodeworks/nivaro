import type { Knex } from 'knex'
import { utcNow } from '../dialect.js'

/**
 * Migration 446 — the idea board: a real `ideas` collection (registered in
 * nivaro_collections / nivaro_fields / nivaro_relations the way the schema
 * editor registers one) so queues, reports and Ask AI read ideas unchanged,
 * plus nivaro_idea_votes (one row per voter per idea).
 *
 * The name carries no nivaro_ prefix on purpose: dashboards, record links and
 * the source pickers refuse system names. A backlog link is an ordinary
 * record link ('relates to'), so nothing extra is stored for it.
 *
 * Every existing non-admin role gets read + create on ideas so anyone can
 * suggest one through the items service (activity, revisions, hooks). Roles
 * made later are granted from the Roles page like any other collection.
 *
 * Idempotent: every step checks before it creates.
 */

const COLLECTION = 'ideas'

const STATUS_CHOICES = [
  { text: 'Under review', value: 'under_review' },
  { text: 'Planned', value: 'planned' },
  { text: 'Built', value: 'built' },
  { text: 'Declined', value: 'declined' }
]

const FIELDS: Array<Record<string, unknown>> = [
  { field: 'id', type: 'integer', interface: 'input', hidden: true, readonly: true },
  { field: 'title', type: 'string', interface: 'input', required: true },
  { field: 'description', type: 'text', interface: 'textarea' },
  {
    field: 'status',
    type: 'string',
    interface: 'select-dropdown',
    options: JSON.stringify({ choices: STATUS_CHOICES })
  },
  { field: 'status_note', type: 'text', interface: 'textarea' },
  { field: 'merged_into', type: 'integer', interface: 'm2o' },
  { field: 'vote_count', type: 'integer', interface: 'input', readonly: true },
  {
    field: 'created_by',
    type: 'uuid',
    interface: 'm2o',
    readonly: true,
    special: JSON.stringify(['user-created'])
  },
  {
    field: 'created_at',
    type: 'datetime',
    interface: 'datetime',
    readonly: true,
    special: JSON.stringify(['date-created'])
  },
  {
    field: 'updated_at',
    type: 'datetime',
    interface: 'datetime',
    readonly: true,
    special: JSON.stringify(['date-updated'])
  }
]

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(COLLECTION))) {
    await knex.schema.createTable(COLLECTION, (t) => {
      t.increments('id').primary()
      t.string('title', 255).notNullable()
      t.text('description').nullable()
      t.string('status', 30).notNullable().defaultTo('under_review')
      t.text('status_note').nullable()
      t.integer('merged_into').nullable()
      t.integer('vote_count').notNullable().defaultTo(0)
      t.uuid('created_by').nullable()
      t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
      t.datetime('updated_at').nullable()
      t.index(['status'], 'idx_ideas_status')
      t.index(['merged_into'], 'idx_ideas_merged_into')
    })
  }

  if (!(await knex.schema.hasTable('nivaro_idea_votes'))) {
    await knex.schema.createTable('nivaro_idea_votes', (t) => {
      t.increments('id').primary()
      t.integer('idea_id').notNullable()
      t.uuid('user_id').notNullable()
      t.datetime('created_at').notNullable().defaultTo(utcNow(knex))
      t.unique(['idea_id', 'user_id'], { indexName: 'uq_idea_votes_idea_user' })
      t.index(['user_id'], 'idx_idea_votes_user')
    })
  }

  if (!(await knex('nivaro_collections').where({ collection: COLLECTION }).first('id'))) {
    await knex('nivaro_collections').insert({
      collection: COLLECTION,
      display_name: 'Ideas',
      singular: 'Idea',
      plural: 'Ideas',
      icon: 'lightbulb',
      note: 'Feature requests from the idea board (Suggest a feature)',
      display_template: '{{title}}',
      hidden: false,
      singleton: false
    })
  }

  let sort = 1
  for (const f of FIELDS) {
    const exists = await knex('nivaro_fields')
      .where({ collection: COLLECTION, field: f.field as string })
      .first('id')
    if (!exists) {
      await knex('nivaro_fields').insert({
        collection: COLLECTION,
        hidden: false,
        readonly: false,
        required: false,
        ...f,
        sort
      })
    }
    sort++
  }

  const relations = [
    { many_field: 'merged_into', one_collection: COLLECTION },
    { many_field: 'created_by', one_collection: 'nivaro_users' }
  ]
  for (const r of relations) {
    const exists = await knex('nivaro_relations')
      .where({ many_collection: COLLECTION, many_field: r.many_field })
      .first('id')
    if (!exists) {
      await knex('nivaro_relations').insert({
        many_collection: COLLECTION,
        many_field: r.many_field,
        one_collection: r.one_collection,
        one_deselect_action: 'nullify'
      })
    }
  }

  const roles = (await knex('nivaro_roles').select('id', 'admin_access')) as Array<{
    id: string
    admin_access: unknown
  }>
  for (const role of roles) {
    if (role.admin_access) continue
    for (const action of ['read', 'create']) {
      const exists = await knex('nivaro_policies')
        .where({ role: role.id, collection: COLLECTION, action })
        .first('id')
      if (!exists) {
        await knex('nivaro_policies').insert({
          role: role.id,
          collection: COLLECTION,
          action,
          fields: '*'
        })
      }
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('nivaro_policies').where({ collection: COLLECTION }).delete()
  await knex('nivaro_relations').where({ many_collection: COLLECTION }).delete()
  await knex('nivaro_fields').where({ collection: COLLECTION }).delete()
  await knex('nivaro_collections').where({ collection: COLLECTION }).delete()
  await knex('nivaro_record_links')
    .where({ from_collection: COLLECTION })
    .orWhere({ to_collection: COLLECTION })
    .delete()
  if (await knex.schema.hasTable('nivaro_idea_votes')) {
    await knex.schema.dropTable('nivaro_idea_votes')
  }
  if (await knex.schema.hasTable(COLLECTION)) {
    await knex.schema.dropTable(COLLECTION)
  }
}
