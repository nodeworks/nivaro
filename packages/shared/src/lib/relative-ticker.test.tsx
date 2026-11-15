// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelativeTime } from '../components/RelativeTime'
import { relativeTickSubscribers, useRelativeText } from './relative-ticker'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-11-14T15:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

let roots: Root[] = []
let host: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  host = document.createElement('div')
  document.body.appendChild(host)
})
afterEach(() => {
  act(() => {
    for (const r of roots) r.unmount()
  })
  roots = []
  document.body.replaceChildren()
  vi.useRealTimers()
})

function mount(node: React.ReactNode, into: HTMLElement = host): Root {
  const root = createRoot(into)
  roots.push(root)
  act(() => root.render(node))
  return root
}

function Text({ value, id }: { value: string | null; id: string }) {
  return <span id={id}>{useRelativeText(value)}</span>
}
const read = (id: string) => document.getElementById(id)?.textContent

describe('useRelativeText (rt4 #23)', () => {
  it('moves forward on its own, from the one shared ticker', () => {
    mount(<Text id='a' value={ago(90_000)} />)
    expect(read('a')).toBe('1m ago')
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(read('a')).toBe('2m ago')
    act(() => {
      vi.advanceTimersByTime(3 * 60_000)
    })
    expect(read('a')).toBe('5m ago')
  })

  it('many readers share one timer and leave it when they go', () => {
    const root = mount(
      <>
        <Text id='a' value={ago(1000)} />
        <Text id='b' value={ago(2000)} />
        <Text id='c' value={ago(3000)} />
      </>
    )
    expect(relativeTickSubscribers()).toBe(3)
    expect(vi.getTimerCount()).toBe(1)
    act(() => root.unmount())
    roots = []
    expect(relativeTickSubscribers()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not subscribe for a time past a week (a date never changes)', () => {
    mount(<Text id='a' value={ago(10 * 86_400_000)} />)
    expect(relativeTickSubscribers()).toBe(0)
    expect(read('a')).not.toMatch(/ago$/)
  })

  it('reads nothing for an empty value', () => {
    mount(<Text id='a' value={null} />)
    expect(read('a')).toBe('')
    expect(relativeTickSubscribers()).toBe(0)
  })

  it('a hidden tab stops the timer and catches up when it is shown again', () => {
    mount(<Text id='a' value={ago(0)} />)
    const state = vi.spyOn(document, 'visibilityState', 'get')
    state.mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(vi.getTimerCount()).toBe(0)
    vi.setSystemTime(NOW + 10 * 60_000)
    state.mockReturnValue('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(read('a')).toBe('10m ago')
    expect(vi.getTimerCount()).toBe(1)
    state.mockRestore()
  })
})

describe('<RelativeTime>', () => {
  it('renders a <time> with the stamp and keeps counting', () => {
    mount(<RelativeTime value={ago(30_000)} />)
    const el = host.querySelector('time')
    expect(el?.textContent).toBe('just now')
    expect(el?.getAttribute('datetime')).toBe(ago(30_000))
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(host.querySelector('time')?.textContent).toBe('2m ago')
  })

  it('takes its own wording', () => {
    mount(<RelativeTime value={ago(0)} format={(v) => `custom ${typeof v}`} />)
    expect(host.querySelector('time')?.textContent).toBe('custom string')
  })
})
