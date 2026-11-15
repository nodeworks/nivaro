// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { RemoteChangeMark, RemoteConflictNotice } from './RemoteChangeUi'
import type { CMSField } from './types'

// Realtime item 1: someone else's save on a field the person is editing — one calm line
// with Keep mine / Take theirs / Merge; Merge only where the field can merge.
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

const client = { request: vi.fn(async () => ({ data: [] })) }
const base = (over: Partial<CMSField>): CMSField =>
  ({
    field: 'f',
    type: 'string',
    interface: 'input',
    label: 'F',
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: 'main',
    ...over
  }) as CMSField

function render(node: React.ReactNode) {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <NivaroProvider client={client as never}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  )
}
const click = (el: Element | null) =>
  act(() => (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('RemoteConflictNotice', () => {
  it('names who saved what and offers Keep mine / Take theirs; no Merge for a number', () => {
    const keep = vi.fn()
    const take = vi.fn()
    render(
      <RemoteConflictNotice
        change={{ was: 1, by: 'Beth', at: new Date().toISOString(), theirs: 5, conflict: true }}
        mine={3}
        field={base({ type: 'integer' })}
        onKeepMine={keep}
        onTakeTheirs={take}
        onMerge={vi.fn()}
      />
    )
    expect(host.textContent).toContain('Beth saved 5')
    expect(host.querySelector('[data-remote-merge]')).toBeNull()
    click(host.querySelector('[data-remote-keep-mine]'))
    click(host.querySelector('[data-remote-take-theirs]'))
    expect(keep).toHaveBeenCalledOnce()
    expect(take).toHaveBeenCalledOnce()
  })

  it('merges tags as a union, honouring a removal until it is put back', () => {
    const onMerge = vi.fn()
    render(
      <RemoteConflictNotice
        change={{
          was: '["a","b"]',
          by: 'Beth',
          at: new Date().toISOString(),
          theirs: '["a","b","x"]',
          conflict: true
        }}
        mine='["a","y"]'
        field={base({ interface: 'tags', type: 'json' })}
        onKeepMine={vi.fn()}
        onMerge={onMerge}
      />
    )
    click(host.querySelector('[data-remote-merge]'))
    // I removed b: shown, not kept.
    const b = host.querySelector('[data-merge-item="b"]')
    expect(b?.getAttribute('aria-pressed')).toBe('false')
    click(host.querySelector('[data-merge-apply]'))
    expect(onMerge).toHaveBeenLastCalledWith('["a","x","y"]')
    // Put b back.
    click(host.querySelector('[data-remote-merge]'))
    click(host.querySelector('[data-merge-item="b"]'))
    click(host.querySelector('[data-merge-apply]'))
    expect(onMerge).toHaveBeenLastCalledWith('["a","b","x","y"]')
  })

  it('a locked field only takes theirs', () => {
    render(
      <RemoteConflictNotice
        change={{
          was: 'a',
          by: 'Beth',
          at: new Date().toISOString(),
          theirs: 'b\nc',
          conflict: true
        }}
        mine={'a\nd'}
        field={base({ interface: 'textarea' })}
        locked
        onKeepMine={vi.fn()}
        onTakeTheirs={vi.fn()}
        onMerge={vi.fn()}
      />
    )
    expect(host.querySelector('[data-remote-keep-mine]')).toBeNull()
    expect(host.querySelector('[data-remote-merge]')).toBeNull()
    expect(host.querySelector('[data-remote-take-theirs]')).not.toBeNull()
  })
})

describe('RemoteChangeMark', () => {
  it('says who changed the field, when, and old → new; a click clears it', () => {
    const dismiss = vi.fn()
    render(
      <RemoteChangeMark
        change={{ was: 'Draft', by: 'Beth', at: new Date().toISOString() }}
        now='Approved'
        field={base({})}
        onDismiss={dismiss}
      />
    )
    const mark = host.querySelector('[data-remote-change-mark]')
    expect(mark?.getAttribute('aria-label')).toBe('Beth changed this just now: Draft → Approved')
    click(mark)
    expect(dismiss).toHaveBeenCalledOnce()
  })
})
