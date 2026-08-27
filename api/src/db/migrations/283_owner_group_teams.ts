import type { Knex } from 'knex'

/**
 * Teams as owners — an owner-group cell can carry whole TEAMS (the
 * nivaro_user_groups registry, #682) alongside individual members. Owner
 * resolution unions team rosters in at read time, so managing the roster in
 * one place updates every cell the team sits in.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_pipeline_owner_group_teams'))) {
    await knex.schema.createTable('nivaro_pipeline_owner_group_teams', (t) => {
      t.increments('id')
      t.uuid('group')
        .notNullable()
        .references('id')
        .inTable('nivaro_pipeline_owner_groups')
        .onDelete('CASCADE')
      t.integer('team_id')
        .notNullable()
        .references('id')
        .inTable('nivaro_user_groups')
        .onDelete('CASCADE')
      t.unique(['group', 'team_id'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_pipeline_owner_group_teams')
}
