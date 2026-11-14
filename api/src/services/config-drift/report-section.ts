import {
  type OpsSectionRow,
  type OpsSectionWindow,
  registerOpsSection
} from '../ops-report/sections.js'
import type { DriftReport } from './store.js'

/** The admin tab the rows open (lib/hubs.ts ENVIRONMENTS_HUB). */
export const DRIFT_PATH = '/environments/changed-here'

/** Exported for tests: the daily report rows for one window (pure). */
export function driftSectionRows(report: DriftReport, win: OpsSectionWindow): OpsSectionRow[] {
  if (!report.active) return []
  if (!report.baseline) {
    return [
      {
        key: 'open',
        label: 'Changed here, not from promotion',
        value: 0,
        unit: 'count',
        note: 'Not tracked yet — no promotion baseline stored',
        href: DRIFT_PATH,
        better: 'down'
      }
    ]
  }
  const open = report.items.filter((i) => !i.intended)
  const start = win.start.getTime()
  const end = win.end.getTime()
  const fresh = open.filter((i) => {
    const t = i.at ? Date.parse(i.at) : Number.NaN
    return t >= start && t < end
  })
  return [
    {
      key: 'open',
      label: 'Changed here, not from promotion',
      value: open.length,
      unit: 'count',
      note: open.length
        ? `${report.totals.tables} table${report.totals.tables === 1 ? '' : 's'} — copy to dev or mark as intended`
        : 'Matches the last promotion',
      href: DRIFT_PATH,
      better: 'down'
    },
    {
      key: 'new',
      label: 'New in this window',
      value: fresh.length,
      unit: 'count',
      better: 'down'
    },
    {
      key: 'intended',
      label: 'Marked as intended',
      value: report.totals.intended,
      unit: 'count',
      better: null
    }
  ]
}

let registered = false

/** "Production-only config changes" in the daily operations report (once per process). */
export function registerDriftReportSection(read: () => Promise<DriftReport>): void {
  if (registered) return
  registered = true
  registerOpsSection('prod_config_changes', 'Production-only config changes', async (win) =>
    driftSectionRows(await read(), win)
  )
}
