import { isMssql } from '../db/dialect.js'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { selectInChunks } from './db-batch.js'
import { bustOwnerGroupCache } from './pipeline-engine.js'

/**
 * Team suggestions from recurring member sets (#745).
 *
 * Owner-group cells (nivaro_pipeline_owner_groups) whose DIRECT member set
 * (nivaro_pipeline_owner_group_users) recurs across several cells are the
 * same crew typed in again and again — the 2026-08-28 owner→team swap did this
 * by hand once. Here it is a standing suggestion: "these 14 cells share the
 * same 4 people — make a team". Applying one creates the team (or links an
 * existing team that already has exactly those members), links it to every
 * cell, and only THEN removes the now-redundant direct member rows — after a
 * backup table + an activity snapshot of every row it removes. Ownership is
 * unchanged by construction: owner resolution unions a linked team's roster
 * into the cell, and the roster is exactly the removed member set.
 *
 * Cells already linked to ANY team are left alone (a mixed cell is a person's
 * deliberate choice), as are single-person cells.
 */

export interface CellMembers {
  group_id: string
  members: string[]
}

export interface MemberSetCluster {
  key: string
  members: string[]
  group_ids: string[]
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

/** Canonical identity of a member set: sorted, upper-cased, de-duplicated ids. */
export function memberSetKey(members: string[]): string {
  return [...new Set(members.map(up))].sort().join(',')
}

/**
 * Pure: cluster cells by identical member set; keep sets with at least
 * `minMembers` people that recur in at least `minCells` cells. Biggest
 * payoff (cells × members) first.
 */
export function clusterMemberSets(
  cells: CellMembers[],
  opts: { minCells?: number; minMembers?: number } = {}
): MemberSetCluster[] {
  const minCells = Math.max(2, opts.minCells ?? 3)
  const minMembers = Math.max(2, opts.minMembers ?? 2)
  const byKey = new Map<string, MemberSetCluster>()
  for (const c of cells) {
    const key = memberSetKey(c.members)
    if (!key) continue
    const members = key.split(',')
    if (members.length < minMembers) continue
    const entry = byKey.get(key) ?? { key, members, group_ids: [] }
    entry.group_ids.push(up(c.group_id))
    byKey.set(key, entry)
  }
  return [...byKey.values()]
    .map((c) => ({ ...c, group_ids: [...new Set(c.group_ids)] }))
    .filter((c) => c.group_ids.length >= minCells)
    .sort(
      (a, b) =>
        b.group_ids.length * b.members.length - a.group_ids.length * a.members.length ||
        b.group_ids.length - a.group_ids.length ||
        a.key.localeCompare(b.key)
    )
}

/** A readable default name from the members: "Beth, Kim, Raj +1". */
export function suggestTeamName(names: string[]): string {
  const firsts = names.map((n) => n.split(' ')[0]).filter(Boolean)
  const head = firsts.slice(0, 3).join(', ')
  return firsts.length > 3 ? `${head} +${firsts.length - 3}` : head || 'New team'
}

interface GroupRow {
  id: string
  name: string | null
  state: string
  template: string
}

async function loadCells(templateId?: string | null) {
  let q = db('nivaro_pipeline_owner_group_users as gu')
    .join('nivaro_pipeline_owner_groups as g', 'g.id', 'gu.group')
    .select('gu.group as group_id', 'gu.user as user_id')
  if (templateId) q = q.where('g.template', templateId)
  const rows = (await q) as Array<{ group_id: string; user_id: string }>
  const linked = new Set(
    (
      (await db('nivaro_pipeline_owner_group_teams').select('group')) as Array<{ group: string }>
    ).map((r) => up(r.group))
  )
  const byGroup = new Map<string, string[]>()
  for (const r of rows) {
    const g = up(r.group_id)
    if (linked.has(g)) continue
    byGroup.set(g, [...(byGroup.get(g) ?? []), up(r.user_id)])
  }
  return [...byGroup.entries()].map(([group_id, members]) => ({ group_id, members }))
}

export interface TeamSuggestion {
  key: string
  members: Array<{ id: string; name: string; status: string | null; redacted: boolean }>
  cells: Array<{
    group_id: string
    group_name: string | null
    template_id: string
    template_name: string | null
    state_id: string
    state_label: string | null
  }>
  cell_count: number
  rows_replaced: number
  suggested_name: string
  /** An existing team with EXACTLY these members — applying links it instead of creating one. */
  existing_team: { id: number; name: string; slug: string } | null
}

export async function findTeamSuggestions(
  opts: { templateId?: string | null; minCells?: number; minMembers?: number } = {}
): Promise<TeamSuggestion[]> {
  const clusters = clusterMemberSets(await loadCells(opts.templateId), opts)
  if (clusters.length === 0) return []
  const groupIds = [...new Set(clusters.flatMap((c) => c.group_ids))]
  const userIds = [...new Set(clusters.flatMap((c) => c.members))]
  const [groups, users, teamRows] = await Promise.all([
    selectInChunks(groupIds, 2000, (chunk) =>
      db('nivaro_pipeline_owner_groups')
        .whereIn('id', chunk)
        .select('id', 'name', 'state', 'template')
    ) as Promise<GroupRow[]>,
    selectInChunks(userIds, 2000, (chunk) =>
      db('nivaro_users')
        .whereIn('id', chunk)
        .select('id', 'first_name', 'last_name', 'email', 'status', 'is_redacted')
    ) as Promise<
      Array<{
        id: string
        first_name: string | null
        last_name: string | null
        email: string | null
        status: string | null
        is_redacted: unknown
      }>
    >,
    db('nivaro_user_group_members as m')
      .join('nivaro_user_groups as t', 't.id', 'm.group_id')
      .select('t.id', 't.name', 't.slug', 'm.user') as Promise<
      Array<{ id: number; name: string; slug: string; user: string }>
    >
  ])
  const groupById = new Map(groups.map((g) => [up(g.id), g]))
  const stateIds = [...new Set(groups.map((g) => g.state))]
  const templateIds = [...new Set(groups.map((g) => g.template))]
  const [stateRows, templateRows] = await Promise.all([
    selectInChunks(stateIds, 2000, (chunk) =>
      db('nivaro_workflow_states').whereIn('id', chunk).select('id', 'label', 'sort')
    ) as Promise<Array<{ id: string; label: string; sort: number }>>,
    selectInChunks(templateIds, 2000, (chunk) =>
      db('nivaro_workflow_templates').whereIn('id', chunk).select('id', 'name')
    ) as Promise<Array<{ id: string; name: string }>>
  ])
  const stateById = new Map(stateRows.map((s) => [up(s.id), s]))
  const templateById = new Map(templateRows.map((t) => [up(t.id), t]))
  const userById = new Map(users.map((u) => [up(u.id), u]))
  const teamMembers = new Map<number, { name: string; slug: string; members: string[] }>()
  for (const r of teamRows) {
    const t = teamMembers.get(r.id) ?? { name: r.name, slug: r.slug, members: [] }
    t.members.push(up(r.user))
    teamMembers.set(r.id, t)
  }
  const teamByKey = new Map<string, { id: number; name: string; slug: string }>()
  for (const [id, t] of teamMembers) {
    const k = memberSetKey(t.members)
    if (!teamByKey.has(k)) teamByKey.set(k, { id, name: t.name, slug: t.slug })
  }
  const nameOf = (id: string) => {
    const u = userById.get(id)
    if (!u) return id
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || id
  }

  return clusters.map((c) => {
    const members = c.members
      .map((id) => {
        const u = userById.get(id)
        return {
          id,
          name: nameOf(id),
          status: u?.status ?? null,
          redacted: u?.is_redacted === true || u?.is_redacted === 1
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
    const cells = c.group_ids
      .map((gid) => {
        const g = groupById.get(gid)
        const st = g ? stateById.get(up(g.state)) : undefined
        const tp = g ? templateById.get(up(g.template)) : undefined
        return {
          group_id: gid,
          group_name: g?.name ?? null,
          template_id: g ? up(g.template) : '',
          template_name: tp?.name ?? null,
          state_id: g ? up(g.state) : '',
          state_label: st?.label ?? null,
          sort: st?.sort ?? 0
        }
      })
      .sort(
        (a, b) => String(a.template_name).localeCompare(String(b.template_name)) || a.sort - b.sort
      )
      .map(({ sort: _s, ...rest }) => rest)
    return {
      key: c.key,
      members,
      cells,
      cell_count: cells.length,
      rows_replaced: cells.length * members.length,
      suggested_name: suggestTeamName(members.map((m) => m.name)),
      existing_team: teamByKey.get(c.key) ?? null
    }
  })
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 190)
}

export interface ApplyPlan {
  dry_run: boolean
  team: { action: 'create' | 'link'; id: number | null; name: string; slug: string | null }
  cells: string[]
  skipped: Array<{ group_id: string; reason: string }>
  rows_removed: number
  backup_table: string | null
}

/**
 * Re-check every cell against the CURRENT database (the suggestion may be
 * minutes old) and either describe what would happen (dry run, the default)
 * or do it. A cell whose member set changed or that gained a team link since
 * is skipped and reported, never forced.
 */
export async function applyTeamSuggestion(input: {
  members: string[]
  group_ids: string[]
  name?: string | null
  existing_team_id?: number | null
  actorId: string
  dryRun?: boolean
}): Promise<ApplyPlan> {
  const dryRun = input.dryRun !== false
  const key = memberSetKey(input.members)
  const members = key ? key.split(',') : []
  if (members.length < 2)
    throw Object.assign(new Error('A team needs at least two members'), { statusCode: 400 })
  const requested = [...new Set(input.group_ids.map(up))].slice(0, 2000)
  if (requested.length === 0)
    throw Object.assign(new Error('group_ids is required'), { statusCode: 400 })

  const [rows, links] = await Promise.all([
    selectInChunks(requested, 2000, (chunk) =>
      db('nivaro_pipeline_owner_group_users')
        .whereIn('group', chunk)
        .select('id', 'group as group_id', 'user as user_id')
    ) as Promise<Array<{ id: number; group_id: string; user_id: string }>>,
    selectInChunks(requested, 2000, (chunk) =>
      db('nivaro_pipeline_owner_group_teams').whereIn('group', chunk).select('group')
    ) as Promise<Array<{ group: string }>>
  ])
  const linked = new Set(links.map((l) => up(l.group)))
  const byGroup = new Map<string, typeof rows>()
  for (const r of rows) byGroup.set(up(r.group_id), [...(byGroup.get(up(r.group_id)) ?? []), r])
  const cells: string[] = []
  const skipped: ApplyPlan['skipped'] = []
  for (const gid of requested) {
    const own = byGroup.get(gid) ?? []
    if (linked.has(gid)) skipped.push({ group_id: gid, reason: 'already linked to a team' })
    else if (memberSetKey(own.map((r) => r.user_id)) !== key)
      skipped.push({ group_id: gid, reason: 'its members changed since the suggestion' })
    else cells.push(gid)
  }

  // Team: an existing team must still have exactly these members.
  let team: ApplyPlan['team']
  if (input.existing_team_id != null) {
    const t = (await db('nivaro_user_groups').where({ id: input.existing_team_id }).first()) as
      | { id: number; name: string; slug: string }
      | undefined
    if (!t) throw Object.assign(new Error('Team not found'), { statusCode: 404 })
    const roster = (await db('nivaro_user_group_members')
      .where({ group_id: t.id })
      .pluck('user')) as string[]
    if (memberSetKey(roster) !== key)
      throw Object.assign(new Error(`${t.name} no longer has exactly these members`), {
        statusCode: 409
      })
    team = { action: 'link', id: t.id, name: t.name, slug: t.slug }
  } else {
    const name = String(input.name ?? '')
      .trim()
      .slice(0, 200)
    if (!name) throw Object.assign(new Error('name is required'), { statusCode: 400 })
    const base = slugify(name) || 'team'
    let slug = base
    for (let n = 2; await db('nivaro_user_groups').where({ slug }).first('id'); n++)
      slug = `${base}-${n}`
    team = { action: 'create', id: null, name, slug }
  }

  const removable = cells.flatMap((gid) => byGroup.get(gid) ?? [])
  const plan: ApplyPlan = {
    dry_run: dryRun,
    team,
    cells,
    skipped,
    rows_removed: removable.length,
    backup_table: null
  }
  if (dryRun || cells.length === 0) return plan

  // Backup FIRST — the rows we are about to remove, as a table (MSSQL; the
  // DB Health backup-tables panel lists zz_ tables for cleanup) and always as
  // an activity snapshot so any dialect can rebuild them.
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  if (isMssql(db)) {
    const table = `zz_backup_og_users_team_${stamp}`
    const ids = removable.map((r) => Number(r.id)).filter(Number.isFinite)
    // CAST strips the IDENTITY property SELECT INTO would copy, so later
    // chunks can INSERT the original ids (bound-parameter cap ≈ 2100).
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000)
      const marks = chunk.map(() => '?').join(',')
      await db.raw(
        i === 0
          ? `SELECT CAST(id AS int) AS id, [group], [user] INTO ?? FROM nivaro_pipeline_owner_group_users WHERE id IN (${marks})`
          : `INSERT INTO ?? (id, [group], [user]) SELECT id, [group], [user] FROM nivaro_pipeline_owner_group_users WHERE id IN (${marks})`,
        [table, ...chunk]
      )
    }
    plan.backup_table = table
  }
  const snapshotId = await logActivity({
    action: 'owner-team-swap-backup',
    user: input.actorId,
    collection: 'nivaro_pipeline_owner_group_users',
    item: team.slug ?? String(team.id),
    comment: JSON.stringify({
      backup_table: plan.backup_table,
      rows: removable.map((r) => ({ id: r.id, group: r.group_id, user: r.user_id }))
    })
  })
  if (!plan.backup_table && snapshotId == null) {
    throw Object.assign(new Error('Could not write the backup snapshot — nothing was changed'), {
      statusCode: 500
    })
  }

  await db.transaction(async (trx) => {
    if (team.action === 'create') {
      await trx('nivaro_user_groups').insert({
        name: team.name,
        slug: team.slug,
        description: `Created from ${cells.length} owner-group cells that shared these members.`,
        created_by: input.actorId,
        created_at: new Date()
      })
      const row = (await trx('nivaro_user_groups').where({ slug: team.slug }).first('id')) as {
        id: number
      }
      team.id = row.id
      for (const user of members) {
        await trx('nivaro_user_group_members').insert({ group_id: row.id, user })
      }
    }
    for (const gid of cells) {
      await trx('nivaro_pipeline_owner_group_teams').insert({ group: gid, team_id: team.id })
    }
    for (let i = 0; i < removable.length; i += 1000) {
      await trx('nivaro_pipeline_owner_group_users')
        .whereIn(
          'id',
          removable.slice(i, i + 1000).map((r) => r.id)
        )
        .del()
    }
  })
  bustOwnerGroupCache()
  await logActivity({
    action: 'owner-team-swap',
    user: input.actorId,
    collection: 'nivaro_user_groups',
    item: String(team.id),
    comment: `${team.action === 'create' ? 'Created' : 'Linked'} ${team.name} on ${cells.length} cell(s); removed ${removable.length} direct member row(s)${plan.backup_table ? ` (backup ${plan.backup_table})` : ''}`
  })
  return plan
}
