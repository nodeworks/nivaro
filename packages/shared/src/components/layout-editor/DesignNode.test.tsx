// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesignNode, markRank, rankChips } from './DesignNode'
import { type DesignTarget, type LayoutDesign, LayoutDesignContext } from './design-context'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const target: DesignTarget = { kind: 'field', field: 'title', group_key: null }

function design(over: Partial<LayoutDesign> = {}): LayoutDesign {
  return {
    selected: null,
    onSelect: vi.fn(),
    showHidden: false,
    inheritedFrom: () => null,
    dnd: {
      draggableProps: () => ({ 'data-draggable': 'yes' }),
      isDragging: () => false,
      dropSlot: () => null
    },
    ...over
  }
}

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

describe('DesignNode', () => {
  it('renders children untouched when no design context', () => {
    act(() =>
      root.render(
        <DesignNode target={target}>
          <span id='c'>hi</span>
        </DesignNode>
      )
    )
    expect(host.innerHTML).toBe('<span id="c">hi</span>')
  })

  it('adds data-design-target, selection outline and click-to-select inside a context', () => {
    const d = design({ selected: target })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span id='c'>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.getAttribute('data-design-target')).toBe('field:title:')
    expect(node.getAttribute('data-selected')).toBe('true')
    expect(node.className).toContain('outline')
    act(() => node.click())
    expect(d.onSelect).toHaveBeenCalledWith(target)
  })

  it('marks inherited nodes and blocks drag', () => {
    const d = design({ inheritedFrom: () => 'Base form' })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.hasAttribute('data-draggable')).toBe(false)
    expect(node.textContent).toContain('from Base form')
  })

  it('Enter on the node selects it; Enter inside a control does not', () => {
    const d = design()
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <input id='inner' />
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    const enter = (el: Element) =>
      act(() => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
    enter(host.querySelector('#inner') as Element)
    expect(d.onSelect).not.toHaveBeenCalled()
    enter(node)
    expect(d.onSelect).toHaveBeenCalledWith(target)
  })

  it('Enter on a native button node (a canvas tab) keeps its native click: select + switch', () => {
    const d = design()
    const tabClick = vi.fn()
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target} asChild pass>
            <button type='button' onClick={tabClick}>
              tab
            </button>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      node.dispatchEvent(key)
    })
    // Not swallowed: the browser turns it into a click (jsdom does not, so click below).
    expect(key.defaultPrevented).toBe(false)
    expect(d.onSelect).not.toHaveBeenCalled()
    act(() => node.click())
    expect(d.onSelect).toHaveBeenCalledWith(target)
    expect(tabClick).toHaveBeenCalled()
  })

  it('Enter on a non-button node is taken: it selects and nothing else acts', () => {
    const d = design()
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      node.dispatchEvent(key)
    })
    expect(key.defaultPrevented).toBe(true)
    expect(d.onSelect).toHaveBeenCalledWith(target)
  })

  it('an inherited (locked) node still takes focus so the keyboard can select it', () => {
    const d = design({ inheritedFrom: () => 'Base form' })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.tabIndex).toBe(0)
    expect(node.getAttribute('role')).toBe('button')
  })

  it('an inherited step or tab gets a dot and a tip, not a chip over its label', () => {
    const d = design({ inheritedFrom: () => 'Unit Order' })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={{ kind: 'group', key: 'basic' }} asChild>
            <div data-design-tab=''>Basic Information</div>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.getAttribute('data-tip')).toBe('From Unit Order')
    const badge = node.querySelector('[data-design-badges]') as HTMLElement
    expect(badge.textContent).toBe('from Unit Order')
    expect(badge.querySelector('.sr-only')).not.toBeNull()
  })

  it('a step with rule tags gets a dot and every tag in its tip (a step clips chips above it)', () => {
    const d = design({
      marks: () => [{ tone: 'slate', text: 'Skipped when Unit is filled' }]
    })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={{ kind: 'group', key: 'basic' }} asChild>
            <div data-design-tab=''>Basic Information</div>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.getAttribute('data-tip')).toBe('Skipped when Unit is filled')
    const badge = node.querySelector('[data-design-badges]') as HTMLElement
    expect(badge.className).toContain('rounded-full')
    expect(badge.querySelector('[data-design-mark]')).toBeNull()
    expect(badge.textContent).toBe('Skipped when Unit is filled')
  })

  it('marks what a previewed role cannot see (faint, tagged) or change (lock tag)', () => {
    const marks: Record<string, 'hidden' | 'readonly'> = { title: 'hidden', amount: 'readonly' }
    const d = design({
      roleMark: (t) =>
        t.kind === 'field' && marks[t.field] ? { kind: marks[t.field], role: 'Finance' } : null
    })
    const amount: DesignTarget = { kind: 'field', field: 'amount', group_key: null }
    const notes: DesignTarget = { kind: 'field', field: 'notes', group_key: null }
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span>t</span>
          </DesignNode>
          <DesignNode target={amount}>
            <span>a</span>
          </DesignNode>
          <DesignNode target={notes}>
            <span>n</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const at = (k: string) => host.querySelector(`[data-design-target="${k}"]`) as HTMLElement
    const tag = (k: string) => at(k).querySelector('[data-design-role-tag]')
    expect(at('field:title:').getAttribute('data-role-mark')).toBe('hidden')
    expect(at('field:title:').className).toContain('opacity-40')
    expect(tag('field:title:')?.textContent).toBe('Hidden for Finance')
    expect(at('field:amount:').getAttribute('data-role-mark')).toBe('readonly')
    expect(at('field:amount:').className).not.toContain('opacity-40')
    expect(tag('field:amount:')?.textContent).toBe('Read-only for Finance')
    expect(at('field:notes:').hasAttribute('data-role-mark')).toBe(false)
    expect(tag('field:notes:')).toBeNull()
    // Still selectable.
    act(() => at('field:title:').click())
    expect(d.onSelect).toHaveBeenCalledWith(target)
  })

  it('shows the drop line without changing the node size', () => {
    const d = design({
      dnd: {
        draggableProps: () => ({}),
        isDragging: () => false,
        dropSlot: () => 'before',
        dropIndicator: () => ({ top: -6, left: 0, width: 120, height: 3 })
      }
    })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target} asChild>
            <div style={{ gridColumn: 'span 6' }}>cell</div>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.className).not.toMatch(/border-[tb]-2/)
    expect(node.style.gridColumn).toBe('span 6')
    const line = node.querySelector('[data-design-drop-indicator]') as HTMLElement
    expect(line.getAttribute('data-design-drop-indicator')).toBe('before')
    expect(line.className).toContain('absolute')
    expect(line.style.width).toBe('120px')
  })

  it("keeps the child's and the dnd handlers, classes and refs", () => {
    const childClick = vi.fn()
    const childRef = vi.fn()
    const dndKey = vi.fn()
    const dndRef = vi.fn()
    const d = design({
      dnd: {
        draggableProps: () => ({ ref: dndRef, onKeyDown: dndKey, tabIndex: 0 }),
        isDragging: () => false,
        dropSlot: () => null
      }
    })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target} asChild pass>
            <button type='button' className='own' ref={childRef} onClick={childClick}>
              tab
            </button>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.className).toContain('own')
    expect(node.className).toContain('cursor-pointer')
    expect(childRef).toHaveBeenCalledWith(node)
    expect(dndRef).toHaveBeenCalledWith(node)
    act(() => node.click())
    expect(d.onSelect).toHaveBeenCalledWith(target)
    expect(childClick).toHaveBeenCalled()
    act(() => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    expect(dndKey).toHaveBeenCalled()
  })

  it('registers a folded header copy as not draggable', () => {
    const draggableProps = vi.fn((_t: DesignTarget, o?: { disabled?: boolean }) =>
      o?.disabled ? {} : { 'data-draggable': 'yes' }
    )
    const d = design({ dnd: { draggableProps, isDragging: () => false, dropSlot: () => 'after' } })
    const tile: DesignTarget = { kind: 'header', field: 'amount' }
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={tile}>
            <span>row</span>
          </DesignNode>
          <DesignNode target={tile} data-design-copy=''>
            <span>copy</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const [row, copy] = Array.from(host.querySelectorAll('[data-design-target]'))
    expect(row.getAttribute('data-draggable')).toBe('yes')
    expect(copy.hasAttribute('data-draggable')).toBe(false)
    expect(copy.querySelector('[data-design-drop-indicator]')).toBeNull()
    expect(draggableProps).toHaveBeenCalledWith(tile, { disabled: true })
  })
})

describe('DesignNode preview marks and overlay', () => {
  it('renders mode tags, rings highlighted nodes and passes overlay clicks through', () => {
    const onChip = vi.fn()
    const d = design({
      marks: () => [
        { text: 'Differs', tone: 'violet', tip: 'A: edit · B: hidden', highlight: true }
      ],
      overlay: () => ({
        className: 'bg-emerald-50',
        chip: (
          <button type='button' id='chip' onClick={onChip}>
            2/3 roles
          </button>
        )
      })
    })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span id='c'>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.className).toContain('outline-dashed')
    expect(node.className).toContain('bg-emerald-50')
    const tag = host.querySelector('[data-design-mark]') as HTMLElement
    expect(tag.textContent).toBe('Differs')
    expect(tag.getAttribute('data-tip')).toBe('A: edit · B: hidden')
    act(() => (host.querySelector('#chip') as HTMLElement).click())
    expect(d.onSelect).toHaveBeenCalledWith(target)
    expect(onChip).toHaveBeenCalled()
  })
})

describe('DesignNode tag row (design review)', () => {
  it('ranks tags: comparison, preview, rule loop, rules, AI, from parent', () => {
    expect(markRank({ kind: 'preview' })).toBe(1)
    expect(markRank({ kind: 'loop' })).toBe(2)
    // A personal-default field says so ahead of plain rule tags (never behind "+n").
    expect(markRank({ kind: 'personal' })).toBe(2)
    expect(markRank({ highlight: true })).toBe(2)
    expect(markRank({})).toBe(3)
    expect(markRank({ kind: 'ai', highlight: true })).toBe(4)
    const { shown, rest } = rankChips([
      { rank: 4, id: 'ai' },
      { rank: 3, id: 'rule-a' },
      { rank: 1, id: 'preview' },
      { rank: 3, id: 'rule-b' }
    ])
    expect(shown.map((c) => c.id)).toEqual(['preview', 'rule-a'])
    expect(rest.map((c) => c.id)).toEqual(['rule-b', 'ai'])
  })

  it('shows two tags, the rest behind "+n" with their names in its tip', () => {
    const d = design({
      marks: () => [
        { text: 'Required', tone: 'amber' },
        { text: 'AI: unclear label', tone: 'violet', highlight: true, kind: 'ai' },
        { text: 'Rule loop', tone: 'amber', highlight: true, kind: 'loop' },
        { text: 'Locked in Review', tone: 'slate', kind: 'preview' }
      ]
    })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const tags = [...host.querySelectorAll('[data-design-mark]')].map((t) => t.textContent)
    expect(tags).toEqual(['Locked in Review', 'Rule loop'])
    const more = host.querySelector('[data-design-more-tags]') as HTMLElement
    expect(more.textContent).toBe('+2')
    expect(more.getAttribute('data-tip')).toBe('Required · AI: unclear label')
  })

  it('an unsaved change is a cyan dot; a peer is an initials avatar', () => {
    const d = design({
      unsaved: () => true,
      peers: () => [{ id: 'u2', name: 'Ben Ode', outline: 'outline-violet-400', chip: '' }]
    })
    act(() =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={target}>
            <span>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    expect(host.querySelector('[data-unsaved-dot]')?.className).toContain('bg-nvr-cyan')
    const peer = host.querySelector('[data-design-peer="u2"]') as HTMLElement
    expect(peer.textContent).toBe('BO')
    expect(peer.getAttribute('data-tip')).toBe('Ben Ode')
  })

  it('who last changed a section shows on the selected section, else only on hover', () => {
    const section: DesignTarget = { kind: 'group', key: 'main' }
    const last = { by: 'Dana Ortiz', at: null }
    const render = (selected: DesignTarget | null) =>
      act(() =>
        root.render(
          <LayoutDesignContext.Provider value={design({ selected, lastChange: () => last })}>
            <DesignNode target={section}>
              <span>hi</span>
            </DesignNode>
          </LayoutDesignContext.Provider>
        )
      )
    render(null)
    const tag = () => host.querySelector('[data-design-last-change]') as HTMLElement
    expect(tag().className).toContain('invisible')
    expect(tag().className).toContain('text-slate-500')
    const node = host.querySelector('[data-design-target]') as HTMLElement
    expect(node.className).toContain('[&:hover>[data-design-last-change]]:visible')
    render(section)
    expect(tag().className).not.toContain('invisible')
  })

  it('the "Controls n" tag sits bottom right, clear of the label and a note marker', () => {
    const note = { text: 'Ask Finance first', by: null, by_name: null, at: '2020-01-01T00:00:00Z' }
    const render = (withNote: boolean) =>
      act(() =>
        root.render(
          <LayoutDesignContext.Provider value={design({ note: () => (withNote ? note : null) })}>
            <DesignNode target={target}>
              <span>hi</span>
            </DesignNode>
          </LayoutDesignContext.Provider>
        )
      )
    render(false)
    const node = () => host.querySelector('[data-design-target]') as HTMLElement
    expect(node().className).toContain('data-[rule-drives]:after:-bottom-2')
    expect(node().className).toContain('data-[rule-drives]:after:right-1')
    render(true)
    expect(node().className).toContain('data-[rule-drives]:after:right-1')
    expect(node().className).not.toContain('data-[rule-drives]:after:left-')
    expect(host.querySelector('[data-editor-note-marker]')).not.toBeNull()
  })
})
