import { HEADER_GROUP_KEY, type LayoutBundle, UNGROUPED_KEY } from '../../../lib/layout-ops'
import type { DesignMark, DesignTarget } from '../design-context'
import { targetKey } from '../design-context'

/**
 * The layout editor's AI tools (#2685 persona test, #2690 visual critique,
 * #2691 autofill corrections): what the admin-only /ai-design routes answer,
 * and the canvas pins their findings become. Nothing here writes a layout —
 * fixes go through the draft like any other change.
 */

export type PersonaSeverity = 'blocking' | 'confusing' | 'minor'

export interface PersonaFinding {
  id: string
  /** `field:<key>`, `group:<key>` or `form`. */
  target: string
  step: string | null
  severity: PersonaSeverity
  problem: string
  suggestion: string | null
  better_label: string | null
  source: 'rules' | 'ai'
}

export interface PersonaResult {
  role: string
  walkthrough: Array<{ key: string; label: string; kind: string; fields: number; required: number }>
  summary: string | null
  steps: Array<{ step: string; feeling: 'clear' | 'unsure' | 'stuck'; note: string }>
  findings: PersonaFinding[]
  dropped: string[]
  ai_configured: boolean
}

export const FORM_TARGET = '__form__'

export interface CritiqueComment {
  id: string
  section: string
  topic: 'density' | 'hierarchy' | 'alignment' | 'other'
  severity: 'high' | 'medium' | 'low'
  comment: string
  suggestion: string | null
  source: 'rules' | 'ai'
}

export interface CritiqueResult {
  summary: string | null
  comments: CritiqueComment[]
  dropped: string[]
  used_image: boolean
  image_skipped: 'invalid' | 'provider' | null
  ai_configured: boolean
}

export interface CorrectedField {
  field: string
  proposed: number
  corrected: number
  kept: number
  share: number
  suggest: boolean
}

export interface AutofillCorrections {
  days: number
  documents: number
  min_proposed: number
  corrected_share: number
  fields: CorrectedField[]
}

/** One finding pinned to the canvas. */
export interface AiPin {
  target: DesignTarget
  text: string
  tone: DesignMark['tone']
  tip: string
}

/** `field:<key>` / `group:<key>` → the canvas node it names on this layout, else null. */
export function targetFromRef(ref: string, bundle: LayoutBundle): DesignTarget | null {
  const m = /^(field|group):(.+)$/.exec(ref)
  if (!m) return null
  if (m[1] === 'group') {
    if (m[2] === UNGROUPED_KEY) return { kind: 'group', key: UNGROUPED_KEY }
    return bundle.groups.some((g) => g.key === m[2]) ? { kind: 'group', key: m[2] } : null
  }
  const p = bundle.placements.find((x) => x.field === m[2] && x.group_key !== HEADER_GROUP_KEY)
  return p ? { kind: 'field', field: p.field, group_key: p.group_key } : null
}

/** A critique section key → its canvas node (the whole form has none). */
export function sectionTarget(section: string, bundle: LayoutBundle): DesignTarget | null {
  if (section === FORM_TARGET) return null
  return targetFromRef(`group:${section}`, bundle)
}

const PERSONA_TONE: Record<PersonaSeverity, DesignMark['tone']> = {
  blocking: 'amber',
  confusing: 'violet',
  minor: 'slate'
}

export function personaPins(r: PersonaResult, bundle: LayoutBundle): AiPin[] {
  const out: AiPin[] = []
  for (const f of r.findings) {
    const target = targetFromRef(f.target, bundle)
    if (!target) continue
    out.push({
      target,
      text: f.severity === 'blocking' ? `Blocks ${r.role}` : `Confuses ${r.role}`,
      tone: PERSONA_TONE[f.severity],
      tip: f.suggestion ? `${f.problem} ${f.suggestion}` : f.problem
    })
  }
  return out
}

export function critiquePins(r: CritiqueResult, bundle: LayoutBundle): AiPin[] {
  const out: AiPin[] = []
  for (const c of r.comments) {
    const target = sectionTarget(c.section, bundle)
    if (!target) continue
    out.push({
      target,
      text: `Design: ${c.topic}`,
      tone: c.severity === 'high' ? 'amber' : 'violet',
      tip: c.suggestion ? `${c.comment} ${c.suggestion}` : c.comment
    })
  }
  return out
}

/** Pins → the canvas `marks` function: several pins on one node fold into one tag. */
export function pinsToMarks(pins: AiPin[]): ((t: DesignTarget) => DesignMark[]) | undefined {
  if (pins.length === 0) return undefined
  const by = new Map<string, AiPin[]>()
  for (const p of pins) {
    const k = targetKey(p.target)
    by.set(k, [...(by.get(k) ?? []), p])
  }
  return (t) => {
    const list = by.get(targetKey(t))
    if (!list) return []
    const first = list[0]
    const tone = list.some((p) => p.tone === 'amber') ? 'amber' : first.tone
    return [
      {
        text: list.length > 1 ? `${first.text} · ${list.length}` : first.text,
        tone,
        tip: list.map((p) => p.tip).join('\n'),
        highlight: true,
        kind: 'ai'
      }
    ]
  }
}

/** Two `marks` functions as one (either may be absent). */
export function mergeMarks(
  a: ((t: DesignTarget) => DesignMark[]) | undefined,
  b: ((t: DesignTarget) => DesignMark[]) | undefined
): ((t: DesignTarget) => DesignMark[]) | undefined {
  if (!a) return b
  if (!b) return a
  return (t) => [...a(t), ...b(t)]
}
