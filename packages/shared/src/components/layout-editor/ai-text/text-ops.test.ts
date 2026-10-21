import { describe, expect, it } from 'vitest'
import { applyLayoutOps, type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import { approveDraftOps, draftTranslations, planLabel, planTextOps, staleReason } from './text-ops'
import type { TextProposal } from './types'

function bundle(): LayoutBundle {
  return {
    layout: { id: 3, collection: 'orders', name: 'Main', layout_type: 'grouped' },
    groups: [{ ...newGroup('details', 'CAR details', 'section', null), sort: 0 }],
    placements: [
      { ...newPlacement('po', 'details'), sort: 0, overrides: { note: 'Old help' } },
      {
        ...newPlacement('status', 'details'),
        sort: 1,
        overrides: { i18n: { fr: { label: 'Statut', draft: true }, de: { label: 'Status' } } }
      }
    ],
    rev: 'r1'
  }
}

const base = {
  place: 'x',
  before: null,
  sentence: 's',
  source: 'ai' as const
}

const proposals: TextProposal[] = [
  {
    ...base,
    id: 'a',
    tool: 'glossary',
    target: { kind: 'group', key: 'details' },
    key: 'label',
    after: "PUB'd details",
    base: 'CAR details'
  },
  {
    ...base,
    id: 'b',
    tool: 'intros',
    target: { kind: 'group', key: 'details' },
    key: 'content',
    after: 'Tell us what you order.',
    base: null,
    tone: 'warn'
  },
  {
    ...base,
    id: 'c',
    tool: 'reading',
    target: { kind: 'placement', field: 'po', group_key: 'details' },
    key: 'note',
    after: 'New help',
    base: 'Old help'
  },
  {
    ...base,
    id: 'd',
    tool: 'placeholders',
    target: { kind: 'placement', field: 'po', group_key: 'details' },
    key: 'placeholder',
    after: 'e.g. PO-471829',
    base: null
  },
  {
    ...base,
    id: 'e',
    tool: 'choices',
    target: { kind: 'placement', field: 'status', group_key: 'details' },
    key: 'choices',
    after: 'Open',
    base: null,
    choices: {
      all: [{ text: 'Open', value: 'open' }],
      changed: [{ value: 'open', before: '$t:open', after: 'Open' }],
      from: 'field'
    }
  },
  {
    ...base,
    id: 'f',
    tool: 'translate',
    target: { kind: 'placement', field: 'po', group_key: 'details' },
    key: 'i18n',
    after: 'Numéro',
    base: null,
    i18n: { locale: 'fr', label: 'Numéro', help: 'Aide' }
  }
]

describe('AI wording → layout ops', () => {
  it('turns every kind of proposal into ops that apply as one batch', () => {
    const b = bundle()
    const plan = planTextOps(b, proposals)
    expect(plan.applied).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    const next = applyLayoutOps(b, plan.ops)
    const g = next.groups.find((x) => x.key === 'details')!
    expect(g.label).toBe("PUB'd details")
    expect(g.content).toBe('Tell us what you order.')
    expect(g.content_tone).toBe('warn')
    const po = next.placements.find((p) => p.field === 'po')!.overrides as Record<string, unknown>
    expect(po).toMatchObject({
      note: 'New help',
      placeholder: 'e.g. PO-471829',
      i18n: { fr: { label: 'Numéro', help: 'Aide', draft: true } }
    })
    const st = next.placements.find((p) => p.field === 'status')!.overrides as Record<string, any>
    expect(st.options.choices).toEqual([{ text: 'Open', value: 'open' }])
    expect(planLabel('glossary', plan.applied.length)).toBe('AI glossary wording: 6 changes')
  })

  it('skips proposals whose text changed since they were asked, and field-bound choices', () => {
    const b = bundle()
    const changed = applyLayoutOps(b, [
      {
        op: 'update_placement',
        at: { field: 'po', group_key: 'details' },
        patch: { overrides: { note: 'Someone edited this' } }
      }
    ])
    expect(staleReason(changed, proposals[2])).toBe('Changed since you asked')
    expect(staleReason(changed, proposals[3])).toBeNull()
    const plan = planTextOps(changed, proposals, new Set(['e']))
    expect(plan.applied).not.toContain('c')
    expect(plan.applied).not.toContain('e')
    expect(plan.skipped).toEqual([{ id: 'c', why: 'Changed since you asked' }])
    expect(staleReason(changed, { ...proposals[0], target: { kind: 'group', key: 'gone' } })).toBe(
      'The section is gone'
    )
  })

  it('lists translation drafts and approves them without touching approved ones', () => {
    const b = bundle()
    const drafts = draftTranslations(b)
    expect(drafts).toEqual([
      { field: 'status', group_key: 'details', locale: 'fr', label: 'Statut', help: null }
    ])
    const next = applyLayoutOps(b, approveDraftOps(b, drafts))
    const ov = next.placements.find((p) => p.field === 'status')!.overrides as Record<string, any>
    expect(ov.i18n).toEqual({ fr: { label: 'Statut' }, de: { label: 'Status' } })
    expect(draftTranslations(next)).toEqual([])
  })
})
