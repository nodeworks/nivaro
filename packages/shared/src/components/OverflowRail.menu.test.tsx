// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fitMenuPeek,
  markRailMenu,
  OverflowRail,
  type RailItem,
  railMenuGroups
} from './OverflowRail'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

// The ⋯ menu (design review 2026-11-15): one left-aligned column, filters above a divider,
// actions below, every row with words (icon-only controls get theirs), arrow keys move.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const restore: Array<() => void> = []
function stubGetter(proto: object, key: string, value: number) {
  const prev = Object.getOwnPropertyDescriptor(proto, key)
  Object.defineProperty(proto, key, { configurable: true, get: () => value })
  restore.push(() => {
    if (prev) Object.defineProperty(proto, key, prev)
    else delete (proto as Record<string, unknown>)[key]
  })
}
beforeEach(() => {
  // Every control 100 px wide on a 150 px bar: everything but the ⋯ folds away.
  stubGetter(HTMLElement.prototype, 'offsetWidth', 100)
  stubGetter(Element.prototype, 'clientWidth', 150)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  while (restore.length) restore.pop()?.()
})

async function tick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

const items: RailItem[] = [
  {
    key: 'refresh',
    priority: 60,
    label: 'Refresh',
    node: (
      <button type='button' aria-label='Refresh the list'>
        <svg aria-hidden='true' />
      </button>
    )
  },
  {
    key: 'sent-back',
    priority: 35,
    kind: 'filter',
    node: (
      <button type='button' aria-pressed={false}>
        Sent back
      </button>
    )
  },
  {
    key: 'copy-link',
    priority: 25,
    node: (
      <button type='button' aria-label='Copy link to this view'>
        <svg aria-hidden='true' />
      </button>
    )
  },
  {
    key: 'focus',
    priority: 30,
    node: (
      <span>
        <button type='button' aria-pressed={false}>
          <svg aria-hidden='true' />
          <span className='sr-only'>Focus mode</span>
        </button>
      </span>
    )
  },
  { key: 'export', priority: 65, node: <button type='button'>Export</button> }
]

async function openMenu() {
  act(() => {
    root.render(
      <div>
        <OverflowRail leadMinWidth={0} items={items} />
      </div>
    )
  })
  await tick()
  const more = host.querySelector('[data-rail-more]') as HTMLButtonElement
  expect(more).not.toBeNull()
  act(() => more.click())
  await tick()
  const menu = document.querySelector('[data-rail-menu]') as HTMLElement
  expect(menu).not.toBeNull()
  return { more, menu }
}

describe('railMenuGroups', () => {
  it('puts filters first and keeps rail order inside each group', () => {
    const g = railMenuGroups(items)
    expect(g.filters.map((i) => i.key)).toEqual(['sent-back'])
    expect(g.actions.map((i) => i.key)).toEqual(['refresh', 'copy-link', 'focus', 'export'])
  })
})

describe('markRailMenu', () => {
  it('labels icon-only controls (item label, else aria-label) and leaves worded ones alone', () => {
    const menu = document.createElement('div')
    menu.innerHTML = `
      <div data-rail-row data-rail-item="refresh"><button aria-label="Refresh the list"><svg aria-hidden="true"></svg></button></div>
      <div data-rail-row data-rail-item="copy"><button aria-label="Copy link to this view"><svg aria-hidden="true"></svg></button></div>
      <div data-rail-row data-rail-item="focus"><span><button><svg aria-hidden="true"></svg><span class="sr-only">Focus mode</span></button></span></div>
      <div data-rail-row data-rail-item="export"><button>Export</button></div>`
    markRailMenu(
      menu,
      new Map([
        ['refresh', 'Refresh'],
        ['focus', 'Focus mode']
      ])
    )
    const primary = (k: string) =>
      menu.querySelector(`[data-rail-item="${k}"] [data-rail-primary]`) as HTMLElement
    expect(primary('refresh').getAttribute('data-rail-label')).toBe('Refresh')
    expect(primary('copy').getAttribute('data-rail-label')).toBe('Copy link to this view')
    // Screen-reader-only text is not visible words: Focus mode still gets a label.
    expect(primary('focus').getAttribute('data-rail-label')).toBe('Focus mode')
    expect(primary('export').hasAttribute('data-rail-label')).toBe(false)
    expect(
      menu.querySelector('[data-rail-item="focus"] > span')?.hasAttribute('data-rail-wrap')
    ).toBe(true)
  })
})

describe('the ⋯ menu', () => {
  it('is one column: filters, a divider, then actions — every row with words', async () => {
    const { menu } = await openMenu()
    const order = Array.from(menu.querySelectorAll('[data-rail-row], [data-rail-divider]')).map(
      (el) => el.getAttribute('data-rail-item') ?? 'divider'
    )
    expect(order[0]).toBe('sent-back')
    expect(order[1]).toBe('divider')
    // Export (highest priority) still fits on the line beside the ⋯.
    expect(order.slice(2)).toEqual(['refresh', 'copy-link', 'focus'])
    expect(menu.textContent).toContain('Show only')
    for (const p of Array.from(menu.querySelectorAll<HTMLElement>('[data-rail-primary]'))) {
      const words = p.getAttribute('data-rail-label') || p.textContent?.trim()
      expect(words, p.outerHTML).toBeTruthy()
    }
    expect(
      menu
        .querySelector('[data-rail-item="refresh"] [data-rail-primary]')
        ?.getAttribute('data-rail-label')
    ).toBe('Refresh')
  })

  it('a folded item that is on puts a dot on ⋯, and an on toggle carries a check', async () => {
    const on: RailItem[] = items.map((i) =>
      i.key === 'sent-back'
        ? {
            ...i,
            active: true,
            node: (
              <button type='button' aria-pressed>
                Sent back
              </button>
            )
          }
        : i
    )
    act(() => {
      root.render(
        <div>
          <OverflowRail leadMinWidth={0} items={on} />
        </div>
      )
    })
    await tick()
    const more = host.querySelector('[data-rail-more]') as HTMLButtonElement
    expect(more.hasAttribute('data-rail-more-active')).toBe(true)
    expect(more.getAttribute('aria-label')).toContain('some are on')
    act(() => more.click())
    await tick()
    const row = document.querySelector('[data-rail-item="sent-back"]') as HTMLElement
    expect(row.querySelector('[data-rail-check]')).not.toBeNull()
    const menu = document.querySelector('[data-rail-menu]') as HTMLElement
    // The check is shown by the menu's CSS for a row whose control is pressed.
    expect(menu.className).toContain('[data-rail-primary][aria-pressed=true]')
  })

  it('no dot when nothing folded is on', async () => {
    await openMenu()
    expect(host.querySelector('[data-rail-more]')?.hasAttribute('data-rail-more-active')).toBe(
      false
    )
  })

  it('arrow keys move through the rows; Escape closes and returns focus to ⋯', async () => {
    const { more, menu } = await openMenu()
    const stops = Array.from(menu.querySelectorAll<HTMLElement>('[data-rail-primary]'))
    expect(document.activeElement).toBe(stops[0])
    act(() => {
      stops[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement).toBe(stops[1])
    act(() => {
      stops[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    })
    expect(document.activeElement).toBe(stops[0])
    act(() => {
      stops[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(document.activeElement).toBe(stops[stops.length - 1])
    act(() => {
      ;(document.activeElement as HTMLElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      )
    })
    await tick()
    expect(document.querySelector('[data-rail-menu]')).toBeNull()
    expect(document.activeElement).toBe(more)
  })

  it('a popover opened from a row opens beside the menu with its own scroll', async () => {
    const nestedItems: RailItem[] = [
      ...items,
      {
        key: 'columns',
        priority: 62,
        node: (
          <Popover>
            <PopoverTrigger asChild>
              <button type='button'>Columns</button>
            </PopoverTrigger>
            <PopoverContent data-testid='columns-pop'>
              <Popover>
                <PopoverTrigger asChild>
                  <button type='button'>Inner</button>
                </PopoverTrigger>
                <PopoverContent data-testid='inner-pop'>picker</PopoverContent>
              </Popover>
            </PopoverContent>
          </Popover>
        )
      }
    ]
    act(() => {
      root.render(
        <div>
          <OverflowRail leadMinWidth={0} items={nestedItems} />
        </div>
      )
    })
    await tick()
    act(() => (host.querySelector('[data-rail-more]') as HTMLButtonElement).click())
    await tick()
    const trigger = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-rail-menu] button')
    ).find((b) => b.textContent === 'Columns') as HTMLButtonElement
    act(() => trigger.click())
    await tick()
    const pop = document.querySelector('[data-testid="columns-pop"]') as HTMLElement
    expect(pop).not.toBeNull()
    expect(pop.hasAttribute('data-rail-popover')).toBe(true)
    // Beside the menu (jsdom has no room, so it flips sides), never down over its rows.
    expect(['left', 'right']).toContain(pop.getAttribute('data-side'))
    expect(pop.className).toContain('overflow-y-auto')
    // The popover's own pickers are not "from the menu".
    act(() =>
      (
        Array.from(pop.querySelectorAll('button')).find(
          (b) => b.textContent === 'Inner'
        ) as HTMLButtonElement
      ).click()
    )
    await tick()
    const inner = document.querySelector('[data-testid="inner-pop"]') as HTMLElement
    expect(inner).not.toBeNull()
    expect(inner.hasAttribute('data-rail-popover')).toBe(false)
  })
})

// Design review round 4: on a phone the menu's cap fell on a row boundary, so it looked
// finished. It now ends part-way through the first row below the fold.
describe('fitMenuPeek', () => {
  function menu(rows: number, rowH: number, avail: number) {
    const el = document.createElement('div')
    el.style.setProperty('--radix-popover-content-available-height', `${avail}px`)
    for (let i = 0; i < rows; i++) {
      const row = document.createElement('div')
      row.setAttribute('data-rail-row', '')
      row.getBoundingClientRect = () =>
        ({ top: 4 + i * rowH, height: rowH, bottom: 4 + (i + 1) * rowH }) as DOMRect
      el.appendChild(row)
    }
    el.getBoundingClientRect = () => ({ top: 0, height: avail }) as DOMRect
    Object.defineProperty(el, 'scrollHeight', { value: 8 + rows * rowH })
    Object.defineProperty(el, 'offsetHeight', { value: avail })
    Object.defineProperty(el, 'clientHeight', { value: avail - 2 })
    document.body.appendChild(el)
    return el
  }

  it('ends a menu that fell on a row boundary part-way through the next row', () => {
    // 36 px rows, 220 px of room: six whole rows (4 + 216) and the seventh hidden.
    const el = menu(10, 36, 222)
    fitMenuPeek(el)
    // Row 6 (top 184) shows 55%: 184 + 19.8 + 2 → 205 px; rows 1–5 whole.
    expect(el.style.getPropertyValue('--nvr-rail-menu-cut')).toBe('205px')
    el.remove()
  })

  it('leaves a menu that fits alone', () => {
    const el = menu(4, 36, 400)
    el.style.setProperty('--nvr-rail-menu-cut', '100px')
    fitMenuPeek(el)
    expect(el.style.getPropertyValue('--nvr-rail-menu-cut')).toBe('')
    el.remove()
  })
})

vi.setConfig({ testTimeout: 10_000 })
