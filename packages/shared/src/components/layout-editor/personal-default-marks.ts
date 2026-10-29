import { useMemo } from 'react'
import type { LayoutBundle } from '../../lib/layout-ops'
import type { DesignMark, DesignTarget } from './design-context'

const placementKey = (field: string, group: string | null) => `${group ?? ''}\u0000${field}`

function overridesOf(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw)
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

/** Placements on this form that let people save their own starting value (overrides.personal_default). */
export function personalDefaultPlacements(bundle: Pick<LayoutBundle, 'placements'>): Set<string> {
  const out = new Set<string>()
  for (const p of bundle.placements) {
    if (overridesOf(p.overrides).personal_default === true)
      out.add(placementKey(p.field, p.group_key))
  }
  return out
}

export const PERSONAL_DEFAULT_MARK: DesignMark = {
  text: 'Personal default',
  tone: 'slate',
  icon: 'person',
  kind: 'personal',
  tip: 'People can save their own starting value for this field on this form. New records start with it.'
}

/** Tags every field placement that allows personal defaults; other targets pass through. */
export function usePersonalDefaultMarks(
  bundle: Pick<LayoutBundle, 'placements'>,
  marks?: (t: DesignTarget) => DesignMark[]
): ((t: DesignTarget) => DesignMark[]) | undefined {
  const placements = bundle.placements
  return useMemo(() => {
    const allowed = personalDefaultPlacements({ placements })
    if (allowed.size === 0) return marks
    return (t: DesignTarget) => {
      const own = marks?.(t) ?? []
      if (t.kind !== 'field' || !allowed.has(placementKey(t.field, t.group_key))) return own
      return [...own, PERSONAL_DEFAULT_MARK]
    }
  }, [placements, marks])
}
