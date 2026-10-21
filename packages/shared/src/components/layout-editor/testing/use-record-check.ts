import { useCallback, useEffect, useState } from 'react'
import { useNivaroClient } from '../../../context'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { bundleToActiveLayout } from '../bundle-to-active'
import { useLayoutBundle } from '../useLayoutDraft'
import { type CheckResult, checkTestRecords, draftResolution } from './testing-api'
import {
  compareOutcomes,
  conditionFields,
  formView,
  type OutcomeChange,
  type PinnedRecord,
  type RecordOutcome,
  samePin
} from './testing-model'

export interface PinCheck {
  pin: PinnedRecord
  result: CheckResult
  /** The baseline: the last save, or the previous check when nothing is unsaved. */
  before: RecordOutcome
  after: RecordOutcome
  changes: OutcomeChange[]
}

export interface CheckRun {
  at: number
  /** What `before` is. */
  against: 'saved' | 'previous' | 'none'
  checks: PinCheck[]
}

// The last run per layout survives the popover closing (and the Save button's
// impact check reusing it), not a reload.
const lastRuns = new Map<number, CheckRun>()

/**
 * Re-check the pinned test records against the draft (#2646) — the same call
 * the Save flow's impact check makes (#2647). The server resolves each record
 * with the stored layouts and with the draft's settings; the fields each one
 * sees come from the saved and the draft form's own rules.
 */
export function useRecordCheck(opts: {
  layoutId: number
  bundle: LayoutBundle | null
  parent: LayoutBundle | null
  pins: PinnedRecord[]
  /** Unsaved changes exist: compare with the last save, else with the previous check. */
  dirty: boolean
  label: (field: string) => string
}) {
  const { layoutId, bundle, parent, pins, dirty, label } = opts
  const client = useNivaroClient()
  const { data: saved = null } = useLayoutBundle(layoutId)
  const [run, setRun] = useState<CheckRun | null>(() => lastRuns.get(layoutId) ?? null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setRun(lastRuns.get(layoutId) ?? null), [layoutId])

  const check = useCallback(async (): Promise<CheckRun | null> => {
    if (!bundle || pins.length === 0) return null
    setRunning(true)
    setError(null)
    try {
      const draftActive = bundleToActiveLayout(bundle, parent).active
      const savedActive = saved ? bundleToActiveLayout(saved, parent).active : draftActive
      const results = await checkTestRecords(client, layoutId, {
        records: pins,
        draft: draftResolution(bundle.layout),
        fields: conditionFields(draftActive, savedActive)
      })
      const prev = lastRuns.get(layoutId) ?? null
      const against: CheckRun['against'] = dirty ? 'saved' : prev ? 'previous' : 'none'
      const outcome = (
        pick: CheckResult['saved'],
        r: CheckResult,
        active: typeof draftActive
      ): RecordOutcome => ({
        form: pick ? { layout_id: pick.layout_id, name: pick.name } : null,
        view:
          r.found && pick?.layout_id === layoutId
            ? formView(active, r.values ?? {}, r.access ?? null)
            : null
      })
      const checks: PinCheck[] = pins.map((pin, i) => {
        const r = results[i] ?? {
          item: pin.item,
          role_id: pin.role_id,
          found: false,
          role: null
        }
        const after = outcome(r.draft ?? null, r, draftActive)
        const before =
          against === 'saved'
            ? outcome(r.saved ?? null, r, savedActive)
            : against === 'previous'
              ? (prev?.checks.find((c) => samePin(c.pin, pin))?.after ?? after)
              : after
        return { pin, result: r, before, after, changes: compareOutcomes(before, after, label) }
      })
      const next = { at: Date.now(), against, checks }
      lastRuns.set(layoutId, next)
      setRun(next)
      return next
    } catch (err) {
      const e = err as { message?: string }
      setError(e?.message || 'The check could not run')
      return null
    } finally {
      setRunning(false)
    }
  }, [bundle, parent, saved, pins, dirty, label, client, layoutId])

  return { run, running, error, check }
}
