import { db } from '../../db/index.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import type { TimelineMark } from './logic.js'

/**
 * The Overview timeline slot sheet (`?today=slot`) — what each mark needs beyond the strip's
 * sentence so the sheet can lead with failures, fold routine runs and filter: which job a run
 * belongs to, how long it took, the first line of its error, whether a person started it, and
 * for a config change who made it. Read only for the marks in the one slot (admin route), never
 * stored in the timeline's shared memo, so the strip's answer stays as small as it was.
 *
 * Never carries values: an error's first line (as the Jobs page shows it), names, ids.
 */

export interface SlotMarkDetail {
  /** Job marks: the job (cron id, `ext:<extension>:<id>`, or a run kind's own key). */
  job_id?: string
  /** The run's own label when it says more than the id. */
  job_label?: string
  /** What kind of run (cron, backfill, recalc…). */
  run_kind?: string
  /** The extension that registered the job. */
  extension?: string
  /** The job's registered plain-language purpose (cron registry). */
  description?: string
  duration_ms?: number
  /** A failed run's first error line, ≤ 300 characters. */
  error?: string
  /** A person started this run (Run now), not the schedule. */
  manual?: boolean
  /** Who: the person who started a run by hand, or who made a config change. */
  user?: string
  user_name?: string
  /** Config marks: the config table written. */
  collection?: string
}

export type SlotMark = TimelineMark & SlotMarkDetail

export interface RegistryEntry {
  id: string
  extensionId?: string
  description?: string
}

interface RunRow {
  id: unknown
  job_id: unknown
  label: unknown
  kind: unknown
  status: unknown
  duration_ms: unknown
  error: unknown
  triggered_by: unknown
}

interface ActRow {
  id: unknown
  user: unknown
  collection: unknown
}

const EXT_RE = /^ext:([^:]+):/

/** The first line of an error, trimmed to 300 characters (the Jobs page's own cut). */
export function firstErrorLine(v: unknown): string | undefined {
  if (v == null) return undefined
  const line = String(v).split('\n')[0].trim()
  if (!line) return undefined
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

/** Pure: the slot's marks with the details read for them. Unknown ids keep the bare mark. */
export function shapeSlotMarks(
  marks: TimelineMark[],
  runs: RunRow[],
  acts: ActRow[],
  names: Map<string, string>,
  registry: RegistryEntry[]
): SlotMark[] {
  const runById = new Map(runs.map((r) => [Number(r.id), r]))
  const actById = new Map(acts.map((a) => [Number(a.id), a]))
  const reg = new Map(registry.map((e) => [e.id, e]))
  const nameOf = (id: string) => names.get(id.toUpperCase()) ?? names.get(id.toLowerCase())
  return marks.map((m) => {
    const out: SlotMark = { ...m }
    if (m.run_id != null) {
      const r = runById.get(m.run_id)
      if (r) {
        const jobId = String(r.job_id ?? '')
        if (jobId) out.job_id = jobId
        const label = r.label == null ? '' : String(r.label).trim()
        if (label && label !== jobId) out.job_label = label.slice(0, 120)
        if (r.kind) out.run_kind = String(r.kind)
        const ext = EXT_RE.exec(jobId)?.[1] ?? reg.get(jobId)?.extensionId
        if (ext) out.extension = ext
        const desc = reg.get(jobId)?.description
        if (desc) out.description = desc.slice(0, 300)
        const ms = Number(r.duration_ms)
        if (r.duration_ms != null && Number.isFinite(ms) && ms >= 0) out.duration_ms = ms
        if (r.status === 'error') {
          const e = firstErrorLine(r.error)
          if (e) out.error = e
        }
        if (r.triggered_by) {
          const u = String(r.triggered_by)
          out.manual = true
          out.user = u
          const n = nameOf(u)
          if (n) out.user_name = n
        }
      }
    }
    if (m.activity_id != null) {
      const a = actById.get(m.activity_id)
      if (a) {
        if (a.collection) out.collection = String(a.collection)
        if (a.user) {
          const u = String(a.user)
          out.user = u
          const n = nameOf(u)
          if (n) out.user_name = n
        }
      }
    }
    return out
  })
}

/** Read the details for one slot's marks (≤ a few hundred ids, chunked). */
export async function enrichSlotMarks(
  marks: TimelineMark[],
  registry: RegistryEntry[]
): Promise<SlotMark[]> {
  const runIds = [...new Set(marks.map((m) => m.run_id).filter((v): v is number => !!v))]
  const actIds = [...new Set(marks.map((m) => m.activity_id).filter((v): v is number => !!v))]
  const [runs, acts] = await Promise.all([
    selectInChunks(
      runIds,
      1000,
      (chunk) =>
        whereInList(
          db('nivaro_job_runs').select(
            'id',
            'job_id',
            'label',
            'kind',
            'status',
            'duration_ms',
            'error',
            'triggered_by'
          ),
          'id',
          chunk
        ).catch(() => []) as Promise<RunRow[]>
    ),
    selectInChunks(
      actIds,
      1000,
      (chunk) =>
        whereInList(db('nivaro_activity').select('id', 'user', 'collection'), 'id', chunk).catch(
          () => []
        ) as Promise<ActRow[]>
    )
  ])
  const people = [
    ...new Set(
      [...runs.map((r) => r.triggered_by), ...acts.map((a) => a.user)]
        .filter(Boolean)
        .map((v) => String(v))
    )
  ]
  let names = new Map<string, string>()
  if (people.length) {
    const { personLabels } = await import('../person-names.js')
    names = await personLabels(people, { revealDeletedName: true }).catch(
      () => new Map<string, string>()
    )
  }
  return shapeSlotMarks(marks, runs, acts, names, registry)
}
