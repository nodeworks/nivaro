// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LintFinding } from '../../../lib/layout-lint'
import { coverageFlags, sortWorstFirst } from '../overview/analysis'
import type { OverviewRow } from '../overview/types'
import { LintButton, LintPanel } from './LintPanel'
import { findingDesignTarget } from './lint-api'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const FINDINGS: LintFinding[] = [
  {
    id: 'required-hidden:main/title',
    rule: 'required-hidden',
    severity: 'error',
    target: { kind: 'field', field: 'title', group_key: 'main' },
    message: 'Title is required, but this form hides it — nobody can fill it here.',
    fix: {
      label: 'Show Title',
      ops: [
        {
          op: 'update_placement',
          at: { field: 'title', group_key: 'main' },
          patch: { is_visible: true }
        }
      ]
    }
  },
  {
    id: 'empty-section:blank',
    rule: 'empty-section',
    severity: 'warn',
    target: { kind: 'group', key: 'blank' },
    message: 'The section Blank holds nothing, so it shows as an empty section.'
  },
  {
    id: 'a11y-contrast:x',
    rule: 'a11y-contrast',
    severity: 'warn',
    target: { kind: 'field', field: 'vendor', group_key: '__header__' },
    message: 'Vendor uses cyan.'
  }
]

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('LintPanel', () => {
  it('lists findings by severity; a click selects, a fix applies as one labelled step', () => {
    const onSelect = vi.fn()
    const apply = vi.fn()
    const onOpenAiReview = vi.fn()
    act(() =>
      root.render(
        <LintPanel
          findings={FINDINGS}
          health={{ score: 82, costs: [{ label: '1 problem', points: 10 }] }}
          ready
          onSelect={onSelect}
          apply={apply}
          onOpenAiReview={onOpenAiReview}
        />
      )
    )
    expect(host.textContent).toContain('1 problem · 2 warnings')
    expect(host.querySelector('[data-health-score]')?.textContent).toBe('82 / 100')
    const sections = [...host.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))
    expect(sections).toEqual(['Health', 'Errors', 'Warnings'])

    const rows = host.querySelectorAll<HTMLElement>('[data-lint-finding]')
    act(() => rows[1].querySelector('button')?.click())
    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', key: 'blank' })

    act(() => host.querySelector<HTMLButtonElement>('[data-lint-fix]')?.click())
    expect(apply).toHaveBeenCalledWith(FINDINGS[0].fix?.ops, { label: 'Show Title' })

    const ai = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('AI review')
    )
    act(() => ai?.click())
    expect(onOpenAiReview).toHaveBeenCalled()
  })

  it('says so when nothing is wrong', () => {
    act(() =>
      root.render(
        <LintPanel findings={[]} health={null} ready onSelect={() => {}} apply={() => {}} />
      )
    )
    expect(host.textContent).toContain('No problems found on this form.')
  })

  it('the top-bar button counts problems and warnings', () => {
    act(() => root.render(<LintButton findings={FINDINGS} active={false} onClick={() => {}} />))
    expect(host.querySelector('[data-checks-count]')?.textContent).toBe('3')
  })
})

describe('findingDesignTarget', () => {
  it('maps header items, slots and fields', () => {
    expect(findingDesignTarget(FINDINGS[2])).toEqual({ kind: 'header', field: 'vendor' })
    expect(
      findingDesignTarget({
        ...FINDINGS[0],
        target: { kind: 'field', field: '__subtitle__', group_key: null }
      })
    ).toEqual({ kind: 'slot', field: '__subtitle__', group_key: null })
    expect(findingDesignTarget({ ...FINDINGS[0], target: { kind: 'layout' } })).toBeNull()
  })
})

const row = (id: number, kind: OverviewRow['reason']['kind']): OverviewRow => ({
  layout_id: id,
  name: `L${id}`,
  layout_type: 'grouped',
  slug: null,
  section: 'forms',
  reason: { kind },
  is_default: kind === 'default',
  new_menu: null,
  shape: { groups: 1, steps_or_tabs: 0, fields: 3 },
  references: [],
  warnings: []
})

describe('overview analysis', () => {
  const cov = {
    sampled: 500,
    limit: 500,
    no_form: 0,
    rule_error: false,
    computed_at: '',
    rows: [
      { layout_id: 1, records: 0, rule_matches: 0 },
      { layout_id: 2, records: 0, rule_matches: 40 },
      { layout_id: 3, records: 460, rule_matches: null },
      { layout_id: 4, records: 40, rule_matches: null }
    ]
  }
  it('flags rules that match nothing and forms nobody gets', () => {
    expect(coverageFlags(row(1, 'record_rule'), cov)).toEqual([
      { tone: 'warn', text: 'Its record rules match none of the sampled records' }
    ])
    expect(coverageFlags(row(2, 'record_rule'), cov)[0].text).toContain('other forms win them')
    expect(coverageFlags(row(3, 'default'), cov)).toEqual([
      { tone: 'muted', text: '460 of 500 sampled records open with it' }
    ])
    expect(coverageFlags(row(4, 'role'), cov)[0].text).toContain('Chosen by role')
  })
  it('sorts worst health first, unscored last', () => {
    const health = new Map([
      [
        1,
        {
          layout_id: 1,
          score: 90,
          costs: [],
          counts: { error: 0, warn: 0, info: 0 },
          unreachable_fields: 0
        }
      ],
      [
        2,
        {
          layout_id: 2,
          score: 40,
          costs: [],
          counts: { error: 0, warn: 0, info: 0 },
          unreachable_fields: 0
        }
      ]
    ])
    expect(
      sortWorstFirst([row(3, 'default'), row(1, 'record_rule'), row(2, 'record_rule')], health).map(
        (r) => r.layout_id
      )
    ).toEqual([2, 1, 3])
  })
})
