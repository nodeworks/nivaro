import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { chunkArray } from './db-batch.js'
import { bustOwnerGroupCache } from './pipeline-engine.js'

// ─── Owner matrix versions (#833) ────────────────────────────────────────────
//
// Template versions snapshot states/transitions/bindings. The owner matrix —
// dimensions, owner groups (filters, priority, max_wip…), their members and
// their team links — churns far more and was unrecoverable: one wrong bulk
// edit on a ~4,000-group template had no way back. Same contract as template
// versions: captured best-effort BEFORE every owner mutation (one onRoute
// capture point in routes/pipelines.ts), deduped by content hash, restore is
// id-preserving and snapshots "before restore" first.
//
// Bursts coalesce: a matrix is edited cell by cell, so a capture within
// COALESCE_MS of the same person's previous capture is skipped — that version
// already holds the state from before the burst. Without this a 30-version
// cap would be 30 cell clicks of history.

export const OWNER_MATRIX_VERSIONS_TABLE = 'nivaro_owner_matrix_versions'
export const MAX_VERSIONS_PER_TEMPLATE = 30
export const COALESCE_MS = 120_000
/** Snapshots above this many bytes are stored gzip+base64 (`gz:` prefix). */
export const COMPRESS_OVER_BYTES = 64 * 1024

export interface OwnerMatrixSnapshot {
  dimensions: Array<Record<string, unknown>>
  groups: Array<Record<string, unknown>>
  members: Array<{ group: string; user: string }>
  teams: Array<{ group: string; team_id: number }>
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

/** Stable, case-normalized snapshot — the same matrix always serializes the same. */
export function normalizeSnapshot(raw: OwnerMatrixSnapshot): OwnerMatrixSnapshot {
  const groups = raw.groups
    .map((g) => ({
      ...g,
      id: up(g.id),
      template: up(g.template),
      state: up(g.state)
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const dimensions = [...raw.dimensions].sort((a, b) => Number(a.id) - Number(b.id))
  const members = raw.members
    .map((m) => ({ group: up(m.group), user: up(m.user) }))
    .sort((a, b) => `${a.group}|${a.user}`.localeCompare(`${b.group}|${b.user}`))
  const teams = raw.teams
    .map((t) => ({ group: up(t.group), team_id: Number(t.team_id) }))
    .sort((a, b) => `${a.group}|${a.team_id}`.localeCompare(`${b.group}|${b.team_id}`))
  return { dimensions, groups, members, teams }
}

export function snapshotHash(json: string): string {
  return createHash('sha256').update(json).digest('hex')
}

export function encodeSnapshot(json: string): string {
  if (Buffer.byteLength(json) <= COMPRESS_OVER_BYTES) return json
  return `gz:${gzipSync(json).toString('base64')}`
}

export function decodeSnapshot(stored: string): OwnerMatrixSnapshot {
  const json = stored.startsWith('gz:')
    ? gunzipSync(Buffer.from(stored.slice(3), 'base64')).toString('utf8')
    : stored
  return JSON.parse(json) as OwnerMatrixSnapshot
}

export async function ownerMatrixVersionsReady(): Promise<boolean> {
  return hasColumn(OWNER_MATRIX_VERSIONS_TABLE, 'content_hash').catch(() => false)
}

/** The template's live owner matrix. */
export async function readOwnerMatrix(
  templateId: string,
  knex: Knex | Knex.Transaction = db
): Promise<OwnerMatrixSnapshot> {
  const bindingIds = knex('nivaro_workflow_bindings').select('id').where({ template: templateId })
  const [dimensions, groups, members, teams] = await Promise.all([
    knex('nivaro_pipeline_owner_dimensions').whereIn('binding', bindingIds).orderBy('id'),
    knex('nivaro_pipeline_owner_groups').where({ template: templateId }),
    knex('nivaro_pipeline_owner_group_users as m')
      .join('nivaro_pipeline_owner_groups as g', 'g.id', 'm.group')
      .where('g.template', templateId)
      .select('m.group as group', 'm.user as user'),
    knex('nivaro_pipeline_owner_group_teams as t')
      .join('nivaro_pipeline_owner_groups as g', 'g.id', 't.group')
      .where('g.template', templateId)
      .select('t.group as group', 't.team_id as team_id')
      .catch(() => [])
  ])
  return normalizeSnapshot({
    dimensions: dimensions as Array<Record<string, unknown>>,
    groups: groups as Array<Record<string, unknown>>,
    members: members as OwnerMatrixSnapshot['members'],
    teams: teams as OwnerMatrixSnapshot['teams']
  })
}

interface Logger {
  warn: (obj: unknown, msg?: string) => void
}
const consoleLogger: Logger = { warn: (obj, msg) => console.warn(msg ?? '', obj) }

/**
 * Capture the template's CURRENT owner matrix as the next version. Returns
 * the version number, or null when skipped (unchanged, coalesced into the
 * same person's capture moments ago, or the table is not there yet). Never
 * throws — a failed capture must not block the owner edit it precedes.
 */
export async function snapshotOwnerMatrixVersion(
  templateId: string,
  userId?: string | null,
  note?: string,
  opts: { force?: boolean; logger?: Logger } = {}
): Promise<number | null> {
  const logger = opts.logger ?? consoleLogger
  try {
    if (!(await ownerMatrixVersionsReady())) return null
    const latest = (await db(OWNER_MATRIX_VERSIONS_TABLE)
      .where({ template: templateId })
      .orderBy('version', 'desc')
      .first('version', 'content_hash', 'created_by', 'created_at')) as
      | { version: number; content_hash: string; created_by: string | null; created_at: Date }
      | undefined
    if (
      !opts.force &&
      latest &&
      userId &&
      up(latest.created_by) === up(userId) &&
      Date.now() - new Date(latest.created_at).getTime() < COALESCE_MS
    ) {
      return null
    }
    const snapshot = await readOwnerMatrix(templateId)
    const json = JSON.stringify(snapshot)
    const hash = snapshotHash(json)
    if (latest && latest.content_hash === hash) return null
    const stored = encodeSnapshot(json)
    const nextVersion = (latest?.version ?? 0) + 1
    await db(OWNER_MATRIX_VERSIONS_TABLE).insert({
      template: templateId,
      version: nextVersion,
      snapshot: stored,
      content_hash: hash,
      bytes: Buffer.byteLength(stored),
      group_count: snapshot.groups.length,
      member_count: snapshot.members.length,
      note: note?.slice(0, 255) ?? null,
      created_by: userId ?? null,
      created_at: new Date()
    })
    await pruneOwnerMatrixVersions(templateId)
    return nextVersion
  } catch (err) {
    logger.warn({ err, templateId }, 'Failed to snapshot owner matrix version')
    return null
  }
}

export async function pruneOwnerMatrixVersions(templateId: string): Promise<number> {
  const stale = (await db(OWNER_MATRIX_VERSIONS_TABLE)
    .where({ template: templateId })
    .orderBy('version', 'desc')
    .offset(MAX_VERSIONS_PER_TEMPLATE)
    .limit(1000)
    .select('id')) as Array<{ id: number }>
  if (stale.length === 0) return 0
  return db(OWNER_MATRIX_VERSIONS_TABLE)
    .whereIn(
      'id',
      stale.map((r) => r.id)
    )
    .delete()
}

export async function loadOwnerMatrixVersion(
  templateId: string,
  versionId: number
): Promise<{ version: number; snapshot: OwnerMatrixSnapshot } | null> {
  const row = (await db(OWNER_MATRIX_VERSIONS_TABLE)
    .where({ template: templateId, id: versionId })
    .first('version', 'snapshot')) as { version: number; snapshot: string } | undefined
  if (!row) return null
  return { version: row.version, snapshot: decodeSnapshot(row.snapshot) }
}

// ─── Diff ────────────────────────────────────────────────────────────────────

const GROUP_IGNORE = new Set(['id', 'template', 'created_at', 'updated_at'])
const DIM_IGNORE = new Set(['id', 'created_at', 'updated_at'])

export interface FieldChange {
  field: string
  from: unknown
  to: unknown
}

export interface GroupDiffEntry {
  id: string
  state: string
  name: string | null
  filters: unknown
  fields: FieldChange[]
  members_added: string[]
  members_removed: string[]
  teams_added: number[]
  teams_removed: number[]
}

export interface OwnerMatrixDiff {
  /** "added" = present in the diff TARGET (usually the live matrix) only. */
  groups: {
    added: GroupDiffEntry[]
    removed: GroupDiffEntry[]
    changed: GroupDiffEntry[]
  }
  dimensions: {
    added: Array<Record<string, unknown>>
    removed: Array<Record<string, unknown>>
    changed: Array<{ id: unknown; label: string; fields: FieldChange[] }>
  }
  totals: {
    groups_added: number
    groups_removed: number
    groups_changed: number
    members_added: number
    members_removed: number
    teams_added: number
    teams_removed: number
    dimensions_changed: number
  }
  truncated: boolean
}

/** Filters are JSON text — compare their parsed form so whitespace is not a change. */
function canonical(field: string, v: unknown): string {
  if (field === 'filters' && typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v))
    } catch {
      return v
    }
  }
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v === null || v === undefined || v === '') return 'null'
  return JSON.stringify(v)
}

function parseFilters(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

function fieldChanges(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  ignore: Set<string>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (ignore.has(k)) continue
    if (canonical(k, a[k]) !== canonical(k, b[k])) {
      out.push({
        field: k,
        from: k === 'filters' ? parseFilters(a[k]) : (a[k] ?? null),
        to: k === 'filters' ? parseFilters(b[k]) : (b[k] ?? null)
      })
    }
  }
  return out
}

function byGroup<T extends { group: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const r of rows) {
    const arr = m.get(r.group) ?? []
    arr.push(r)
    m.set(r.group, arr)
  }
  return m
}

const DIFF_LIST_CAP = 300

/** Per-cell diff between two owner-matrix snapshots (group keyed by id). */
export function diffOwnerMatrix(
  fromRaw: OwnerMatrixSnapshot,
  toRaw: OwnerMatrixSnapshot
): OwnerMatrixDiff {
  const from = normalizeSnapshot(fromRaw)
  const to = normalizeSnapshot(toRaw)
  const fromGroups = new Map(from.groups.map((g) => [String(g.id), g]))
  const toGroups = new Map(to.groups.map((g) => [String(g.id), g]))
  const fromMembers = byGroup(from.members)
  const toMembers = byGroup(to.members)
  const fromTeams = byGroup(from.teams)
  const toTeams = byGroup(to.teams)

  const entry = (g: Record<string, unknown>): GroupDiffEntry => ({
    id: String(g.id),
    state: String(g.state),
    name: (g.name as string | null) ?? null,
    filters: parseFilters(g.filters),
    fields: [],
    members_added: [],
    members_removed: [],
    teams_added: [],
    teams_removed: []
  })

  const added: GroupDiffEntry[] = []
  const removed: GroupDiffEntry[] = []
  const changed: GroupDiffEntry[] = []
  const totals = {
    groups_added: 0,
    groups_removed: 0,
    groups_changed: 0,
    members_added: 0,
    members_removed: 0,
    teams_added: 0,
    teams_removed: 0,
    dimensions_changed: 0
  }

  for (const [id, g] of toGroups) {
    if (fromGroups.has(id)) continue
    const e = entry(g)
    e.members_added = (toMembers.get(id) ?? []).map((m) => m.user)
    e.teams_added = (toTeams.get(id) ?? []).map((t) => t.team_id)
    totals.members_added += e.members_added.length
    totals.teams_added += e.teams_added.length
    added.push(e)
  }
  for (const [id, g] of fromGroups) {
    if (toGroups.has(id)) continue
    const e = entry(g)
    e.members_removed = (fromMembers.get(id) ?? []).map((m) => m.user)
    e.teams_removed = (fromTeams.get(id) ?? []).map((t) => t.team_id)
    totals.members_removed += e.members_removed.length
    totals.teams_removed += e.teams_removed.length
    removed.push(e)
  }
  for (const [id, a] of fromGroups) {
    const b = toGroups.get(id)
    if (!b) continue
    const fields = fieldChanges(a, b, GROUP_IGNORE)
    const fm = new Set((fromMembers.get(id) ?? []).map((m) => m.user))
    const tm = new Set((toMembers.get(id) ?? []).map((m) => m.user))
    const ft = new Set((fromTeams.get(id) ?? []).map((t) => t.team_id))
    const tt = new Set((toTeams.get(id) ?? []).map((t) => t.team_id))
    const membersAdded = [...tm].filter((u) => !fm.has(u))
    const membersRemoved = [...fm].filter((u) => !tm.has(u))
    const teamsAdded = [...tt].filter((t) => !ft.has(t))
    const teamsRemoved = [...ft].filter((t) => !tt.has(t))
    if (
      fields.length +
        membersAdded.length +
        membersRemoved.length +
        teamsAdded.length +
        teamsRemoved.length ===
      0
    )
      continue
    const e = entry(b)
    e.fields = fields
    e.members_added = membersAdded
    e.members_removed = membersRemoved
    e.teams_added = teamsAdded
    e.teams_removed = teamsRemoved
    totals.members_added += membersAdded.length
    totals.members_removed += membersRemoved.length
    totals.teams_added += teamsAdded.length
    totals.teams_removed += teamsRemoved.length
    changed.push(e)
  }
  totals.groups_added = added.length
  totals.groups_removed = removed.length
  totals.groups_changed = changed.length

  const fromDims = new Map(from.dimensions.map((d) => [String(d.id), d]))
  const toDims = new Map(to.dimensions.map((d) => [String(d.id), d]))
  const dimsAdded = to.dimensions.filter((d) => !fromDims.has(String(d.id)))
  const dimsRemoved = from.dimensions.filter((d) => !toDims.has(String(d.id)))
  const dimsChanged: OwnerMatrixDiff['dimensions']['changed'] = []
  for (const [id, a] of fromDims) {
    const b = toDims.get(id)
    if (!b) continue
    const fields = fieldChanges(a, b, DIM_IGNORE)
    if (fields.length > 0)
      dimsChanged.push({ id: b.id, label: String(b.label ?? b.field ?? id), fields })
  }
  totals.dimensions_changed = dimsAdded.length + dimsRemoved.length + dimsChanged.length

  const truncated =
    added.length > DIFF_LIST_CAP || removed.length > DIFF_LIST_CAP || changed.length > DIFF_LIST_CAP
  return {
    groups: {
      added: added.slice(0, DIFF_LIST_CAP),
      removed: removed.slice(0, DIFF_LIST_CAP),
      changed: changed.slice(0, DIFF_LIST_CAP)
    },
    dimensions: { added: dimsAdded, removed: dimsRemoved, changed: dimsChanged },
    totals,
    truncated
  }
}

// ─── Restore ─────────────────────────────────────────────────────────────────

export interface OwnerMatrixRestoreResult {
  groups: { inserted: number; updated: number; deleted: number; skipped_missing_state: number }
  members: { inserted: number; deleted: number; skipped_missing_user: number }
  teams: { inserted: number; deleted: number; skipped_missing_team: number }
  dimensions: {
    inserted: number
    updated: number
    deleted: number
    skipped_missing_binding: number
  }
}

async function liveColumns(knex: Knex | Knex.Transaction, table: string): Promise<Set<string>> {
  const info = (await knex(table).columnInfo()) as Record<string, unknown>
  return new Set(Object.keys(info))
}

function pick(row: Record<string, unknown>, cols: Set<string>, omit: string[] = []) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (cols.has(k) && !omit.includes(k)) out[k] = v
  return out
}

/**
 * Make the template's live owner matrix equal the stored version. Id-
 * preserving: owner groups keep their uuid (insert with the snapshot id,
 * update in place), members and team links are reconciled by their natural
 * key, dimensions update in place by id (a deleted one comes back under a new
 * id — filters key on the dimension FIELD, not its id). Only what differs is
 * written, inside one transaction. Groups whose state no longer exists,
 * members whose user no longer exists, teams that were deleted and dimensions
 * whose binding is gone are skipped and counted.
 */
export async function restoreOwnerMatrixVersion(
  templateId: string,
  versionId: number
): Promise<OwnerMatrixRestoreResult> {
  const stored = await loadOwnerMatrixVersion(templateId, versionId)
  if (!stored) throw new Error('Version not found')
  const target = normalizeSnapshot(stored.snapshot)

  const result: OwnerMatrixRestoreResult = {
    groups: { inserted: 0, updated: 0, deleted: 0, skipped_missing_state: 0 },
    members: { inserted: 0, deleted: 0, skipped_missing_user: 0 },
    teams: { inserted: 0, deleted: 0, skipped_missing_team: 0 },
    dimensions: { inserted: 0, updated: 0, deleted: 0, skipped_missing_binding: 0 }
  }

  await db.transaction(async (trx) => {
    const live = await readOwnerMatrix(templateId, trx)
    const groupCols = await liveColumns(trx, 'nivaro_pipeline_owner_groups')
    const dimCols = await liveColumns(trx, 'nivaro_pipeline_owner_dimensions')

    const liveStates = new Set(
      (
        (await trx('nivaro_workflow_states')
          .where({ template: templateId })
          .select('id')) as Array<{
          id: string
        }>
      ).map((s) => up(s.id))
    )

    // ── Groups ──
    const liveGroups = new Map(live.groups.map((g) => [String(g.id), g]))
    const targetGroups = new Map(target.groups.map((g) => [String(g.id), g]))
    const keptGroups = new Set<string>()
    const inserts: Array<Record<string, unknown>> = []
    for (const [id, g] of targetGroups) {
      if (!liveStates.has(up(g.state))) {
        result.groups.skipped_missing_state++
        continue
      }
      keptGroups.add(id)
      const cur = liveGroups.get(id)
      if (!cur) {
        inserts.push({ ...pick(g, groupCols), id, template: templateId })
        continue
      }
      if (fieldChanges(cur, g, GROUP_IGNORE).length > 0) {
        await trx('nivaro_pipeline_owner_groups')
          .where({ id })
          .update(pick(g, groupCols, ['id', 'template']))
        result.groups.updated++
      }
    }
    for (const chunk of chunkArray(inserts, 100)) {
      await trx('nivaro_pipeline_owner_groups').insert(chunk)
      result.groups.inserted += chunk.length
    }
    const deleteGroups = [...liveGroups.keys()].filter((id) => !targetGroups.has(id))
    for (const chunk of chunkArray(deleteGroups, 500)) {
      // Members and team links FK the group with CASCADE; delete them first
      // anyway so the counts below are honest and no cascade path is relied on.
      await trx('nivaro_pipeline_owner_group_users').whereIn('group', chunk).delete()
      await trx('nivaro_pipeline_owner_group_teams')
        .whereIn('group', chunk)
        .delete()
        .catch(() => 0)
      result.groups.deleted += await trx('nivaro_pipeline_owner_groups')
        .whereIn('id', chunk)
        .delete()
    }

    // ── Members ──
    const liveMemberKeys = new Set(
      live.members.filter((m) => targetGroups.has(m.group)).map((m) => `${m.group}|${m.user}`)
    )
    const targetMemberKeys = new Set(target.members.map((m) => `${m.group}|${m.user}`))
    const memberDeletes = [...liveMemberKeys].filter((k) => !targetMemberKeys.has(k))
    const deletesByGroup = new Map<string, string[]>()
    for (const k of memberDeletes) {
      const [group, user] = k.split('|')
      const arr = deletesByGroup.get(group) ?? []
      arr.push(user)
      deletesByGroup.set(group, arr)
    }
    for (const [group, users] of deletesByGroup) {
      for (const chunk of chunkArray(users, 500)) {
        result.members.deleted += await trx('nivaro_pipeline_owner_group_users')
          .where({ group })
          .whereIn('user', chunk)
          .delete()
      }
    }
    const memberInserts = target.members.filter(
      (m) => keptGroups.has(m.group) && !liveMemberKeys.has(`${m.group}|${m.user}`)
    )
    if (memberInserts.length > 0) {
      const userIds = [...new Set(memberInserts.map((m) => m.user))]
      const existing = new Set<string>()
      for (const chunk of chunkArray(userIds, 1000)) {
        const rows = (await trx('nivaro_users').whereIn('id', chunk).select('id')) as Array<{
          id: string
        }>
        for (const r of rows) existing.add(up(r.id))
      }
      const rows = memberInserts.filter((m) => existing.has(m.user))
      result.members.skipped_missing_user += memberInserts.length - rows.length
      for (const chunk of chunkArray(rows, 500)) {
        await trx('nivaro_pipeline_owner_group_users').insert(
          chunk.map((m) => ({ group: m.group, user: m.user }))
        )
        result.members.inserted += chunk.length
      }
    }

    // ── Team links ──
    const liveTeamKeys = new Set(
      live.teams.filter((t) => targetGroups.has(t.group)).map((t) => `${t.group}|${t.team_id}`)
    )
    const targetTeamKeys = new Set(target.teams.map((t) => `${t.group}|${t.team_id}`))
    for (const k of liveTeamKeys) {
      if (targetTeamKeys.has(k)) continue
      const [group, teamId] = k.split('|')
      result.teams.deleted += await trx('nivaro_pipeline_owner_group_teams')
        .where({ group, team_id: Number(teamId) })
        .delete()
    }
    const teamInserts = target.teams.filter(
      (t) => keptGroups.has(t.group) && !liveTeamKeys.has(`${t.group}|${t.team_id}`)
    )
    if (teamInserts.length > 0) {
      const teamIds = [...new Set(teamInserts.map((t) => t.team_id))]
      const existing = new Set(
        (
          (await trx('nivaro_user_groups').whereIn('id', teamIds).select('id')) as Array<{
            id: number
          }>
        ).map((r) => Number(r.id))
      )
      const rows = teamInserts.filter((t) => existing.has(t.team_id))
      result.teams.skipped_missing_team += teamInserts.length - rows.length
      for (const chunk of chunkArray(rows, 500)) {
        await trx('nivaro_pipeline_owner_group_teams').insert(
          chunk.map((t) => ({ group: t.group, team_id: t.team_id }))
        )
        result.teams.inserted += chunk.length
      }
    }

    // ── Dimensions ──
    const liveBindings = new Set(
      (
        (await trx('nivaro_workflow_bindings')
          .where({ template: templateId })
          .select('id')) as Array<{
          id: number
        }>
      ).map((b) => String(b.id))
    )
    const liveDims = new Map(live.dimensions.map((d) => [String(d.id), d]))
    const targetDims = new Map(target.dimensions.map((d) => [String(d.id), d]))
    for (const [id, d] of targetDims) {
      if (!liveBindings.has(String(d.binding))) {
        result.dimensions.skipped_missing_binding++
        continue
      }
      const cur = liveDims.get(id)
      if (cur) {
        if (fieldChanges(cur, d, DIM_IGNORE).length > 0) {
          await trx('nivaro_pipeline_owner_dimensions')
            .where({ id: Number(id) })
            .update(pick(d, dimCols, ['id']))
          result.dimensions.updated++
        }
        continue
      }
      await trx('nivaro_pipeline_owner_dimensions').insert(pick(d, dimCols, ['id']))
      result.dimensions.inserted++
    }
    const dimDeletes = [...liveDims.keys()].filter((id) => !targetDims.has(id)).map(Number)
    if (dimDeletes.length > 0) {
      result.dimensions.deleted += await trx('nivaro_pipeline_owner_dimensions')
        .whereIn('id', dimDeletes)
        .delete()
    }
  })

  bustOwnerGroupCache()
  return result
}
