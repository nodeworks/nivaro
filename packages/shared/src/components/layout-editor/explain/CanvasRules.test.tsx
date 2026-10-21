// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesignNode } from '../DesignNode'
import { type DesignTarget, type LayoutDesign, LayoutDesignContext } from '../design-context'
import { requestInspectorTab, useInspectorTabRequest } from '../inspector/tab-request'
import { explainMarks, RuleLoopsBanner } from './CanvasRules'
import { fieldOfTargetKey, useDriverHover } from './driver-hover'
import type { RuleDep } from './rule-graph'
import type { CanvasExplain } from './use-explain'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const field: DesignTarget = { kind: 'field', field: 'amount', group_key: 'main' }

function design(marks: LayoutDesign['marks']): LayoutDesign {
  return {
    selected: null,
    onSelect: vi.fn(),
    showHidden: false,
    inheritedFrom: () => null,
    dnd: { draggableProps: () => ({}), isDragging: () => false, dropSlot: () => null },
    marks
  }
}

const explain = (over: Partial<CanvasExplain> = {}): CanvasExplain => ({
  layout: { groups: [], placements: [] },
  deps: [],
  loops: [],
  fieldChips: new Map([
    [
      'amount',
      [
        {
          state: 'required',
          origin: 'placement',
          text: 'Required here',
          tip: 'Amount is required on this form (Rules tab)',
          open: { kind: 'tab', tab: 'rules' }
        }
      ]
    ]
  ]),
  groupChips: new Map([
    [
      'main',
      [
        {
          kind: 'shows_when',
          text: 'Shows when Kind is A',
          tip: 'Main shows only when Kind is A',
          open: { kind: 'group', key: 'main' }
        }
      ]
    ]
  ]),
  describe: [{ field: 'amount', label: 'Amount' }],
  groupLabel: (k) => k,
  ...over
})

describe('explainMarks', () => {
  it('tags fields and sections; a click opens the source', () => {
    const open = vi.fn()
    const marks = explainMarks(explain(), { chips: true, open })
    const m = marks?.(field) ?? []
    expect(m.map((x) => x.text)).toEqual(['Required here'])
    m[0].onClick?.()
    expect(open).toHaveBeenCalledWith({ kind: 'tab', tab: 'rules' }, field)
    expect(marks?.({ kind: 'group', key: 'main' }).map((x) => x.text)).toEqual([
      'Shows when Kind is A'
    ])
  })

  it('keeps loop tags and ghost tags with the Rules view off', () => {
    const marks = explainMarks(
      explain({ loops: [{ kind: 'cycle', fields: ['amount', 'kind'], kinds: ['field_rule'] }] }),
      { chips: false, ghostTags: new Map([['amount', 'Default: Yes']]), open: vi.fn() }
    )
    expect(marks?.(field).map((x) => x.text)).toEqual(['Rule loop', 'Default: Yes'])
    expect(marks?.({ kind: 'group', key: 'main' })).toEqual([])
  })

  it('returns nothing when there is nothing to say', () => {
    expect(
      explainMarks(explain({ fieldChips: new Map(), groupChips: new Map() }), {
        chips: true,
        open: vi.fn()
      })
    ).toBeUndefined()
  })
})

describe('a clickable tag on a design node', () => {
  it('selects the node, then runs the tag', () => {
    const onClick = vi.fn()
    const d = design(() => [{ text: 'Required here', tone: 'amber', onClick }])
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={field}>
            <input />
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const tag = host.querySelector('button[data-design-mark]') as HTMLButtonElement
    expect(tag.textContent).toBe('Required here')
    act(() => tag.click())
    expect(d.onSelect).toHaveBeenCalledWith(field)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

function HoverCanvas({ deps }: { deps: RuleDep[] }) {
  const ref = useDriverHover(deps)
  return (
    <div ref={ref}>
      <div data-design-target='field:kind:main' id='driver'>
        <span id='inner'>Kind</span>
      </div>
      <div data-design-target='group:extra' id='section' />
      <div data-design-target='field:status:main' id='status' />
      <div data-design-target='header:status' id='status-header' />
      <div data-design-target='field:other:main' id='other' />
    </div>
  )
}

describe('useDriverHover', () => {
  it('rings what the hovered field controls and tags it with the count', () => {
    const deps: RuleDep[] = [
      { driver: 'kind', kind: 'visibility', target: { kind: 'group', key: 'extra' } },
      { driver: 'kind', kind: 'field_rule', target: { kind: 'field', field: 'status' } }
    ]
    act(() => root.render(<HoverCanvas deps={deps} />))
    const inner = host.querySelector('#inner') as HTMLElement
    act(() => {
      inner.dispatchEvent(new Event('pointerover', { bubbles: true }))
    })
    const attr = (id: string, a: string) => host.querySelector(`#${id}`)?.getAttribute(a)
    expect(attr('driver', 'data-rule-drives')).toBe('Controls 2')
    expect(attr('section', 'data-rule-dependent')).toBe('shows')
    expect(attr('status', 'data-rule-dependent')).toBe('fills')
    expect(attr('status-header', 'data-rule-dependent')).toBe('fills')
    expect(attr('other', 'data-rule-dependent')).toBeNull()
    // Moving onto a field that drives nothing clears it all.
    act(() => {
      host.querySelector('#other')?.dispatchEvent(new Event('pointerover', { bubbles: true }))
    })
    expect(attr('driver', 'data-rule-drives')).toBeNull()
    expect(attr('section', 'data-rule-dependent')).toBeNull()
  })

  it('reads the field of a target key', () => {
    expect(fieldOfTargetKey('field:kind:main')).toBe('kind')
    expect(fieldOfTargetKey('field:kind:')).toBe('kind')
    expect(fieldOfTargetKey('header:kind')).toBe('kind')
    expect(fieldOfTargetKey('group:main')).toBeNull()
  })
})

function TabProbe({ field, onTab }: { field: string; onTab: (t: string) => void }) {
  useInspectorTabRequest(field, onTab)
  return null
}

describe('inspector tab requests', () => {
  it('reaches a mounted inspector of that field, or one that mounts later, once', () => {
    const onTab = vi.fn()
    act(() => root.render(<TabProbe field='amount' onTab={onTab} />))
    act(() => requestInspectorTab('other', 'rules'))
    expect(onTab).not.toHaveBeenCalled()
    act(() => requestInspectorTab('amount', 'rules'))
    expect(onTab).toHaveBeenCalledWith('rules')
    act(() => requestInspectorTab('later', 'advanced'))
    const late = vi.fn()
    act(() => root.render(<TabProbe field='later' onTab={late} />))
    expect(late).toHaveBeenCalledWith('advanced')
    act(() => root.render(<TabProbe field='amount' onTab={onTab} />))
    expect(onTab).toHaveBeenCalledTimes(1)
  })
})

describe('RuleLoopsBanner', () => {
  it('lists loops with a way to the field', () => {
    const onShow = vi.fn()
    act(() =>
      root.render(
        <RuleLoopsBanner
          explain={explain({
            loops: [
              { kind: 'self', fields: ['amount'], group: 'g', kinds: ['visibility'] },
              { kind: 'cycle', fields: ['a', 'b'], kinds: ['field_rule'] }
            ]
          })}
          onShow={onShow}
        />
      )
    )
    expect(host.textContent).toContain('Rule loop: Amount is inside g')
    expect(host.textContent).toContain('1 more')
    const show = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show')
    act(() => show?.click())
    expect(onShow).toHaveBeenCalledWith('amount')
  })
})
