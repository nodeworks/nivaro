// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FoldArea, RowGroupCell, rowMemberField } from './form-structure-ui'
import type { CMSField } from './types'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// #2697 rows and #2698 the fold on the record page.

const field = (name: string, over: Partial<CMSField> = {}): CMSField =>
  ({
    field: name,
    type: 'string',
    interface: null,
    label: name[0].toUpperCase() + name.slice(1),
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: 'ship',
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    ...over
  }) as CMSField

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

describe('RowGroupCell', () => {
  it('shows one label, one required marker and a caption per field', () => {
    const rendered: string[] = []
    act(() =>
      root.render(
        <RowGroupCell
          row={{ key: 'row', label: 'Address', fields: ['street', 'city', 'zip'] }}
          members={[field('street', { required: true }), field('city'), field('zip')]}
          containerWidth={900}
          renderMember={(f) => {
            rendered.push(`${f.field}:${f.label}`)
            return <input aria-label={f.field} />
          }}
        />
      )
    )
    const group = host.querySelector('[data-row-group="row"]') as HTMLElement
    expect(group.tagName).toBe('FIELDSET')
    expect(group.querySelector('label')?.textContent).toBe('Address*')
    expect(group.querySelectorAll('.text-destructive')).toHaveLength(1)
    expect([...group.querySelectorAll('[data-row-member] p')].map((p) => p.textContent)).toEqual([
      'Street',
      'City',
      'Zip'
    ])
    // The host renders each member; the label is the row's.
    expect(rendered).toEqual(['street:Street', 'city:City', 'zip:Zip'])
    expect(rowMemberField(field('city')).label).toBe('')
  })

  it('stacks in a narrow section and names the row from its fields when unlabelled', () => {
    act(() =>
      root.render(
        <RowGroupCell
          row={{ key: 'row', label: '', fields: ['qty', 'unit'] }}
          members={[field('qty'), field('unit')]}
          containerWidth={400}
          renderMember={() => null}
        />
      )
    )
    expect(host.querySelector('label')?.textContent).toBe('Qty / Unit')
    expect(host.querySelector('.flex-col')).not.toBeNull()
  })
})

describe('FoldArea', () => {
  const fold = (props: Partial<Parameters<typeof FoldArea>[0]>) => (
    <FoldArea count={3} open={false} forcedOpen={false} onToggle={() => {}} {...props}>
      <p data-folded>hidden fields</p>
    </FoldArea>
  )

  it('shows "Show 3 more" closed and toggles', () => {
    const onToggle = vi.fn()
    act(() => root.render(fold({ onToggle })))
    const button = host.querySelector('button') as HTMLButtonElement
    expect(button.textContent).toBe('Show 3 more')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('[data-folded]')).toBeNull()
    act(() => button.click())
    expect(onToggle).toHaveBeenCalledOnce()
    act(() => root.render(fold({ open: true })))
    expect(host.querySelector('[data-folded]')).not.toBeNull()
    expect(host.querySelector('button')?.textContent).toBe('Show fewer')
  })

  it('opens on its own when a folded field has a value, with no way to fold it away', () => {
    act(() => root.render(fold({ forcedOpen: true })))
    expect(host.querySelector('[data-folded]')).not.toBeNull()
    expect(host.querySelector('button')).toBeNull()
  })

  it('on the canvas lists the folded fields under a line naming the fold', () => {
    act(() => root.render(fold({ design: true })))
    expect(host.textContent).toContain('Behind “Show 3 more” while empty')
    expect(host.querySelector('[data-folded]')).not.toBeNull()
  })

  it('renders nothing with nothing folded', () => {
    act(() => root.render(fold({ count: 0 })))
    expect(host.innerHTML).toBe('')
  })
})
