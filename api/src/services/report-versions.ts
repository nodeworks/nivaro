import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * Report config versioning — the layout/workflow-template pattern applied to
 * Report Studio: a full snapshot (report row fields + widgets WITH ids) is
 * captured before every mutating save, content-hash deduped, pruned to the
 * newest 30. Restore is id-preserving where possible so report alerts (which
 * reference widget uuids with no FK) keep pointing at the same widgets.
 */

const KEEP_VERSIONS = 30

interface VersionSnapshot {
  report: {
    name: string
    icon: string | null
    description: string | null
    global_filters: string | null
  }
  widgets: Array<Record<string, unknown>>
}

async function buildSnapshot(reportId: string): Promise<VersionSnapshot | null> {
  const report = await db('nivaro_report_defs').where({ id: reportId }).first()
  if (!report) return null
  const widgets = await db('nivaro_report_widgets').where({ report: reportId }).orderBy('sort')
  return {
    report: {
      name: String(report.name ?? ''),
      icon: (report.icon as string | null) ?? null,
      description: (report.description as string | null) ?? null,
      global_filters: (report.global_filters as string | null) ?? null
    },
    widgets: widgets.map((w) => ({
      id: w.id,
      type: w.type,
      title: w.title,
      collection: w.collection,
      config: w.config,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      sort: w.sort
    }))
  }
}

/** Best-effort: never blocks the mutation it precedes. */
export async function snapshotReportVersion(
  reportId: string,
  note: string,
  createdBy: string | null
): Promise<void> {
  try {
    const snap = await buildSnapshot(reportId)
    if (!snap) return
    const json = JSON.stringify(snap)
    const hash = createHash('sha256').update(json).digest('hex')
    const latest = (await db('nivaro_report_versions')
      .where({ report: reportId })
      .orderBy('version', 'desc')
      .first('version', 'snapshot')) as { version: number; snapshot: string } | undefined
    if (latest) {
      const latestHash = createHash('sha256').update(String(latest.snapshot)).digest('hex')
      if (latestHash === hash) return
    }
    const version = (latest?.version ?? 0) + 1
    await db('nivaro_report_versions').insert({
      report: reportId,
      version,
      snapshot: json,
      note: note.slice(0, 255),
      created_by: createdBy,
      created_at: new Date()
    })
    // Prune to the newest KEEP_VERSIONS
    const stale = (await db('nivaro_report_versions')
      .where({ report: reportId })
      .orderBy('version', 'desc')
      .offset(KEEP_VERSIONS)
      .select('id')) as Array<{ id: number }>
    if (stale.length > 0) {
      await db('nivaro_report_versions')
        .whereIn(
          'id',
          stale.map((s) => s.id)
        )
        .del()
    }
  } catch {
    /* versioning must never break a save */
  }
}

export async function restoreReportVersion(
  reportId: string,
  versionId: number,
  restoredBy: string | null
): Promise<{ restored: boolean; widgets: number } | { error: string }> {
  const row = (await db('nivaro_report_versions')
    .where({ report: reportId, id: versionId })
    .first()) as { snapshot: string; version: number } | undefined
  if (!row) return { error: 'Version not found' }
  let snap: VersionSnapshot
  try {
    snap = JSON.parse(String(row.snapshot)) as VersionSnapshot
  } catch {
    return { error: 'Version snapshot is unreadable' }
  }
  // Reversibility: capture the CURRENT state first, so a restore can be undone.
  await snapshotReportVersion(reportId, `before restoring v${row.version}`, restoredBy)

  await db('nivaro_report_defs').where({ id: reportId }).update({
    name: snap.report.name,
    icon: snap.report.icon,
    description: snap.report.description,
    global_filters: snap.report.global_filters,
    updated_at: new Date()
  })
  await db('nivaro_report_widgets').where({ report: reportId }).del()
  if (snap.widgets.length > 0) {
    await db('nivaro_report_widgets').insert(
      snap.widgets.map((w, i) => ({
        id:
          typeof w.id === 'string' && /^[0-9a-f-]{36}$/i.test(w.id)
            ? w.id
            : randomUUID(),
        report: reportId,
        type: w.type ?? 'kpi',
        title: w.title ?? '',
        collection: w.collection ?? null,
        config: w.config ?? null,
        x: Number(w.x ?? 0),
        y: Number(w.y ?? 0),
        w: Number(w.w ?? 3),
        h: Number(w.h ?? 2),
        sort: Number(w.sort ?? i)
      }))
    )
  }
  return { restored: true, widgets: snap.widgets.length }
}
