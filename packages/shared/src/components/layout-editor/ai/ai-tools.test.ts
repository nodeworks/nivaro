import { describe, expect, it } from 'vitest'
import { promptTokens, readAiFill, showsAiButton } from '../../../lib/ai-fill'
import {
  applyLayoutOps,
  type GroupRow,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'
import {
  type CritiqueResult,
  critiquePins,
  FORM_TARGET,
  mergeMarks,
  type PersonaResult,
  personaPins,
  pinsToMarks,
  targetFromRef
} from './ai-tools-api'
import {
  checkSectionPlan,
  hasAutofillCheck,
  highlightPlan,
  placedFields,
  planApplies
} from './autofill-ops'

const group = (key: string, type: string, parent: string | null, sort: number) =>
  ({ ...newGroup(key, key.toUpperCase(), type, parent), sort }) as GroupRow
const place = (field: string, group_key: string | null, sort: number) =>
  ({ ...newPlacement(field, group_key), sort }) as PlacementRow

const flat = (): LayoutBundle => ({
  layout: { id: 1, collection: 'invoices' },
  rev: 'r1',
  groups: [group('main', 'section', null, 0), group('extra', 'section', null, 1)],
  placements: [
    place('vendor', 'main', 0),
    place('amount', 'main', 1),
    place('po', 'extra', 0),
    place('vendor', HEADER_GROUP_KEY, 0)
  ]
})

const steps = (): LayoutBundle => ({
  layout: { id: 2, collection: 'invoices', tab_mode: 'steps' },
  rev: 'r1',
  groups: [
    group('steps', 'container', null, 0),
    group('one', 'tab', 'steps', 0),
    group('two', 'tab', 'steps', 1)
  ],
  placements: [place('vendor', 'one', 0), place('amount', 'two', 0), place('po', 'two', 1)]
})

const labelOf = (f: string) => f.toUpperCase()

describe('autofill tuning ops (#2691)', () => {
  it('highlights body placements only, as one valid batch, and undoes the same way', () => {
    const b = flat()
    expect(placedFields(b, ['vendor', 'ghost', 'po'])).toEqual(['vendor', 'po'])
    const plan = highlightPlan(b, ['vendor', 'ghost'], labelOf)
    expect(plan?.ops).toHaveLength(1)
    expect(plan?.ops[0]).toMatchObject({
      op: 'update_placement',
      at: { field: 'vendor', group_key: 'main' },
      patch: { overrides: { autofill_check: true } }
    })
    expect(plan?.steps).toEqual(['Highlight VENDOR when the form is filled from a document'])
    expect(planApplies(b, plan!)).toBeNull()
    const after = applyLayoutOps(b, plan!.ops)
    expect(hasAutofillCheck(after, 'vendor')).toBe(true)
    // Already on: nothing to do; off removes the key and keeps other overrides.
    expect(highlightPlan(after, ['vendor'], labelOf)).toBeNull()
    const off = highlightPlan(after, ['vendor'], labelOf, false)
    const cleared = applyLayoutOps(after, off!.ops)
    expect(hasAutofillCheck(cleared, 'vendor')).toBe(false)
  })

  it('keeps other overrides when switching the highlight', () => {
    const b = flat()
    b.placements[0] = { ...b.placements[0], overrides: JSON.stringify({ label: 'Supplier' }) }
    const plan = highlightPlan(b, ['vendor'], labelOf)
    expect(plan?.ops[0]).toMatchObject({
      patch: { overrides: { label: 'Supplier', autofill_check: true } }
    })
  })

  it('adds a "Check these" section first on a flat form', () => {
    const b = flat()
    const plan = checkSectionPlan(b, ['po', 'vendor'], labelOf)!
    expect(plan.steps[0]).toBe('Add a section "Check these" at the top of the form')
    const after = applyLayoutOps(b, plan.ops)
    const top = after.groups.filter((g) => g.parent_key == null).sort((x, y) => x.sort - y.sort)
    expect(top[0]).toMatchObject({ key: 'check_these', label: 'Check these' })
    expect(
      after.placements.filter((p) => p.group_key === 'check_these').map((p) => p.field)
    ).toEqual(['po', 'vendor'])
    // The header copy of vendor stays in the header.
    expect(
      after.placements.some((p) => p.field === 'vendor' && p.group_key === HEADER_GROUP_KEY)
    ).toBe(true)
  })

  it('adds a first step on a steps form', () => {
    const b = steps()
    const plan = checkSectionPlan(b, ['amount'], labelOf)!
    expect(plan.steps).toEqual(['Add a first step "Check these"', 'Move AMOUNT into it'])
    const after = applyLayoutOps(b, plan.ops)
    const tabs = after.groups
      .filter((g) => g.parent_key === 'steps')
      .sort((x, y) => x.sort - y.sort)
    expect(tabs.map((g) => g.key)).toEqual(['check_these', 'one', 'two'])
    expect(checkSectionPlan(b, ['ghost'], labelOf)).toBeNull()
  })
})

describe('canvas pins (#2685 #2690)', () => {
  it('resolves refs to canvas targets, never the header copy', () => {
    const b = flat()
    expect(targetFromRef('field:vendor', b)).toEqual({
      kind: 'field',
      field: 'vendor',
      group_key: 'main'
    })
    expect(targetFromRef('group:extra', b)).toEqual({ kind: 'group', key: 'extra' })
    expect(targetFromRef(`group:${UNGROUPED_KEY}`, b)).toEqual({
      kind: 'group',
      key: UNGROUPED_KEY
    })
    expect(targetFromRef('field:ghost', b)).toBeNull()
    expect(targetFromRef('form', b)).toBeNull()
  })

  it('turns findings and comments into marks, folding several on one node', () => {
    const b = flat()
    const persona: PersonaResult = {
      role: 'Clerk',
      walkthrough: [],
      summary: null,
      steps: [],
      findings: [
        {
          id: 'a',
          target: 'field:vendor',
          step: 'main',
          severity: 'blocking',
          problem: 'Required but hidden.',
          suggestion: 'Add a default.',
          better_label: null,
          source: 'rules'
        },
        {
          id: 'b',
          target: 'field:ghost',
          step: null,
          severity: 'minor',
          problem: 'x',
          suggestion: null,
          better_label: null,
          source: 'ai'
        }
      ],
      dropped: [],
      ai_configured: true
    }
    const critique: CritiqueResult = {
      summary: null,
      comments: [
        {
          id: 'c',
          section: 'main',
          topic: 'density',
          severity: 'medium',
          comment: 'Crowded.',
          suggestion: null,
          source: 'ai'
        },
        {
          id: 'd',
          section: FORM_TARGET,
          topic: 'hierarchy',
          severity: 'low',
          comment: 'Order.',
          suggestion: null,
          source: 'ai'
        }
      ],
      dropped: [],
      used_image: false,
      image_skipped: null,
      ai_configured: true
    }
    const pins = [...personaPins(persona, b), ...critiquePins(critique, b)]
    expect(pins).toHaveLength(2)
    const marks = pinsToMarks([...pins, pins[0]])!
    expect(marks({ kind: 'field', field: 'vendor', group_key: 'main' })).toEqual([
      {
        text: 'Blocks Clerk · 2',
        tone: 'amber',
        tip: 'Required but hidden. Add a default.\nRequired but hidden. Add a default.',
        highlight: true
      }
    ])
    expect(marks({ kind: 'group', key: 'main' })[0]).toMatchObject({ text: 'Design: density' })
    expect(marks({ kind: 'group', key: 'extra' })).toEqual([])
    expect(pinsToMarks([])).toBeUndefined()
    const both = mergeMarks(() => [{ text: 'x', tone: 'slate' }], marks)!
    expect(both({ kind: 'group', key: 'main' }).map((m) => m.text)).toEqual([
      'x',
      'Design: density'
    ])
  })
})

describe('AI fill per field (#2692)', () => {
  it('reads the setting and decides the button', () => {
    const ov = { ai_generate: { enabled: true, prompt: 'Describe {{vendor}} and {{ po }}' } }
    expect(readAiFill(ov)).toEqual({ enabled: true, prompt: 'Describe {{vendor}} and {{ po }}' })
    expect(promptTokens('Describe {{vendor}} and {{ po }} {{vendor}}')).toEqual(['vendor', 'po'])
    expect(showsAiButton(ov, false, false)).toEqual({ show: true, perField: true })
    expect(showsAiButton({ ai_generate: { enabled: false } }, true, true)).toEqual({
      show: false,
      perField: true
    })
    expect(showsAiButton({ ai_generate: { enabled: true } }, true, true).show).toBe(false)
    expect(showsAiButton(null, true, true)).toEqual({ show: true, perField: false })
    expect(showsAiButton(null, true, false).show).toBe(false)
  })
})
