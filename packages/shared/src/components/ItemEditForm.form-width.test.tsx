// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import { FORM_PAIR_MIN_PX, isHalfSection, sectionRows } from './item-edit/section-rows'
import type { ActiveLayoutData, CMSField, FieldGroup } from './item-edit/types'
import type { LayoutDesign } from './layout-editor/design-context'

// Record-form section width (migration 526, nivaro_field_groups.form_width): two
// half sections next to each other share one row; a full section, a panel or a
// tabs holder breaks the row; a lone half still takes half the row. The read
// width (read_width) never changes the form.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function field(name: string, group_key: string, sort: number): CMSField {
  return {
    field: name,
    type: 'string',
    interface: 'input',
    label: name,
    required: false,
    hidden: false,
    readonly: false,
    sort,
    group_key,
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    layout_assigned: true
  }
}

function section(
  id: number,
  key: string,
  sort: number,
  over: Partial<FieldGroup> & { read_width?: string | null } = {}
): FieldGroup {
  return { id, key, label: key, type: 'section', icon: null, sort, is_collapsed: false, ...over }
}

// left + right pair; wide is full; lone is a half alone; reader only has a read width.
const GROUPS: FieldGroup[] = [
  section(1, 'left', 0, { form_width: 'half' }),
  section(2, 'right', 1, { form_width: 'half', is_collapsed: true }),
  section(3, 'wide', 2),
  section(4, 'lone', 3, { form_width: 'half' }),
  section(5, 'reader', 4, { read_width: 'half' })
]
const FIELDS = [
  field('a', 'left', 0),
  field('b', 'right', 0),
  field('c', 'wide', 0),
  field('d', 'lone', 0),
  field('e', 'reader', 0)
]
const LAYOUT: ActiveLayoutData = {
  layout: {
    id: 7,
    name: 'Order form',
    tab_mode: null,
    validate_before_next: false,
    summary_enabled: false,
    summary_show_all: false,
    ai_enabled: false
  },
  groups: GROUPS,
  assignments: FIELDS.map((f) => ({
    field: f.field,
    sort: f.sort,
    group_key: f.group_key,
    is_visible: true
  })),
  ungrouped_sort: 99
}

function makeClient() {
  return {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: { _method?: string; _path: string }) => {
      const p = cmd._path
      if (p === '/collection-layouts/active') return { data: LAYOUT }
      if (p === '/field-config/orders' || p === '/field-config/orders/project')
        return { data: FIELDS }
      if (p === '/collections/orders') return { data: { display_name: 'Orders' } }
      if (p === '/items/orders/1') return { data: { id: 1, a: 'A', b: 'B', c: 'C', d: 'D' } }
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
      return { data: [] }
    })
  }
}

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
const g = globalThis as Record<string, unknown>
g.ResizeObserver ??= NoopObserver
g.IntersectionObserver ??= NoopObserver
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false
})) as typeof window.matchMedia
Element.prototype.scrollIntoView ??= () => {}
g.CSS ??= { escape: (v: string) => v }

// The section stack's measured width (jsdom lays nothing out).
let stackWidth = 1000
const realRect = HTMLElement.prototype.getBoundingClientRect
beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.hasAttribute('data-section-stack'))
      return { width: stackWidth, height: 0, top: 0, left: 0, right: 0, bottom: 0 } as DOMRect
    return realRect.call(this)
  }
})

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
  HTMLElement.prototype.getBoundingClientRect = realRect
  stackWidth = 1000
  window.localStorage.clear()
})

async function mount(props: Partial<Parameters<typeof ItemEditForm>[0]>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={makeClient() as never}>
          <ItemEditForm collection='orders' documentTitle={false} {...props} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  for (let i = 0; i < 80 && !host.querySelector('[data-section-key="reader"]'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300))
  })
}

const sectionEl = (key: string) => host.querySelector(`[data-section-key="${key}"]`)
const rowOf = (key: string) => sectionEl(key)?.closest('[data-form-row]') ?? null

function makeDesign(): LayoutDesign {
  return {
    selected: null,
    onSelect: vi.fn(),
    showHidden: false,
    inheritedFrom: () => null,
    dnd: { draggableProps: () => ({}), isDragging: () => false, dropSlot: () => null }
  }
}

describe('record-form section width', () => {
  it('two half sections share one row; a full one and a read-width-only one do not', async () => {
    await mount({ itemId: '1' })
    const pair = rowOf('left')
    expect(pair).not.toBeNull()
    expect(rowOf('right')).toBe(pair)
    expect(pair?.getAttribute('data-form-row-cols')).toBe('2')
    expect(pair?.className).toContain('grid-cols-2')
    // Full and read_width-only sections sit straight in the stack, never in a row.
    expect(rowOf('wide')).toBeNull()
    expect(rowOf('reader')).toBeNull()
    // A half with no half neighbour is a row of its own: half the width.
    const lone = rowOf('lone')
    expect(lone).not.toBeNull()
    expect(lone).not.toBe(pair)
    expect(lone?.querySelectorAll('[data-form-width="half"]').length).toBe(1)
    // The collapsed half keeps its place in the pair.
    expect(pair?.querySelectorAll('[data-form-width="half"]').length).toBe(2)
  })

  it('stacks the pair on a narrow form (phones)', async () => {
    stackWidth = FORM_PAIR_MIN_PX - 1
    await mount({ itemId: '1' })
    const pair = rowOf('left')
    expect(rowOf('right')).toBe(pair)
    expect(pair?.getAttribute('data-form-row-cols')).toBe('1')
    expect(pair?.className).toContain('grid-cols-1')
  })

  it('the layout editor canvas lays the draft out the same way', async () => {
    await mount({
      design: {
        layout: LAYOUT,
        record: { id: 1, a: 'A', b: 'B', c: 'C', d: 'D' },
        context: makeDesign(),
        onRefusedWrite: vi.fn()
      }
    })
    const pair = rowOf('left')
    expect(pair).not.toBeNull()
    expect(rowOf('right')).toBe(pair)
    expect(rowOf('wide')).toBeNull()
  })

  it('a form without half sections renders no rows', async () => {
    const saved = LAYOUT.groups
    LAYOUT.groups = GROUPS.map((g) => ({ ...g, form_width: null }))
    try {
      await mount({ itemId: '1' })
      expect(host.querySelector('[data-form-row]')).toBeNull()
      expect(sectionEl('left')).not.toBeNull()
    } finally {
      LAYOUT.groups = saved
    }
  })
})

describe('sectionRows', () => {
  const half = (key: string) => ({ key, type: 'section', form_width: 'half' })
  const full = (key: string) => ({ key, type: 'section', form_width: null })
  const keys = (items: Array<{ key: string } | string>) =>
    sectionRows(items, isHalfSection).map((r) =>
      r.kind === 'full'
        ? String(typeof r.item === 'string' ? r.item : r.item.key)
        : r.items.map((i) => (typeof i === 'string' ? i : i.key)).join('+')
    )

  it('pairs consecutive halves two at a time; anything else breaks the pair', () => {
    expect(keys([half('a'), half('b'), half('c'), full('d'), half('e')])).toEqual([
      'a+b',
      'c',
      'd',
      'e'
    ])
    expect(keys([half('a'), '__pipeline__', half('b')])).toEqual(['a', '__pipeline__', 'b'])
  })

  it('only top-level sections can be half: never a tab, tabs holder or text block', () => {
    expect(isHalfSection({ type: 'tab', form_width: 'half' })).toBe(false)
    expect(isHalfSection({ type: 'container', form_width: 'half' })).toBe(false)
    expect(isHalfSection({ type: 'content', form_width: 'half' })).toBe(false)
    expect(isHalfSection({ type: 'section', form_width: 'half', container_id: 3 })).toBe(false)
    expect(isHalfSection({ type: 'metadata', form_width: 'half' })).toBe(true)
    expect(isHalfSection({ type: 'section', read_width: 'half' })).toBe(false)
    expect(isHalfSection('__ungrouped__')).toBe(false)
  })
})
