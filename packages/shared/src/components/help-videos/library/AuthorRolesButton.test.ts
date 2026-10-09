// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  authorRoles: vi.fn(),
  setAuthorRoles: vi.fn(),
  rolesRequest: vi.fn()
}))

vi.mock('../../../context', () => ({
  useItemEditAuth: () => ({ isAdmin: true, userId: 'U1' }),
  useNivaroClient: () => ({ request: h.rolesRequest })
}))
vi.mock('../api', () => ({
  helpVideoApi: () => ({ authorRoles: h.authorRoles, setAuthorRoles: h.setAuthorRoles }),
  helpVideoKeys: { all: ['help-videos'] }
}))
// Plain stand-ins for the Radix popover and the role picker.
vi.mock('../../ui/popover', async () => {
  const { createContext, createElement: e, useContext } = await import('react')
  const Ctx = createContext<{ open: boolean; set: (o: boolean) => void }>({
    open: false,
    set: () => {}
  })
  return {
    Popover: ({
      open,
      onOpenChange,
      children
    }: {
      open: boolean
      onOpenChange: (o: boolean) => void
      children: ReactNode
    }) => e(Ctx.Provider, { value: { open, set: onOpenChange } }, children),
    PopoverTrigger: ({ children }: { children: ReactNode }) => {
      const c = useContext(Ctx)
      return e('span', { 'data-trigger': '', onClick: () => c.set(!c.open) }, children)
    },
    PopoverContent: ({ children }: { children: ReactNode }) => {
      const c = useContext(Ctx)
      return c.open ? e('div', null, children) : null
    }
  }
})
vi.mock('../editor/PickerCombo', async () => {
  const { createElement: e } = await import('react')
  return {
    PickerCombo: ({
      options,
      onPick
    }: {
      options: Array<{ value: string; label: string }>
      onPick: (v: string) => void
    }) =>
      e(
        'div',
        null,
        options.map((o) =>
          e(
            'button',
            { key: o.value, 'data-pick': o.value, onClick: () => onPick(o.value) },
            o.label
          )
        )
      ),
    RemovableChip: ({
      children,
      removeLabel,
      onRemove
    }: {
      children: ReactNode
      removeLabel: string
      onRemove: () => void
    }) =>
      e(
        'span',
        { 'data-chip': '' },
        children,
        e('button', { 'aria-label': removeLabel, onClick: onRemove }, 'x')
      )
  }
})

const { AuthorRolesButton } = await import('./AuthorRolesButton')

const ROLES = [
  { id: 'R1', name: 'Role One' },
  { id: 'R2', name: 'Role Two' },
  { id: 'R3', name: 'Role Three' }
]

let root: ReturnType<typeof createRoot> | null = null
let el: HTMLElement

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}
async function mountOpen() {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root?.render(
      createElement(QueryClientProvider, { client: qc }, createElement(AuthorRolesButton))
    )
  })
  await act(async () => {
    el.querySelector<HTMLElement>('[data-trigger]')?.click()
  })
  await flush()
}
const chips = () => [...el.querySelectorAll('[data-chip]')].map((c) => c.firstChild?.textContent)
const click = async (sel: string) => {
  await act(async () => {
    el.querySelector<HTMLElement>(sel)?.click()
  })
}

beforeEach(() => {
  h.authorRoles.mockReset().mockResolvedValue(['R1'])
  h.setAuthorRoles.mockReset().mockResolvedValue({})
  h.rolesRequest.mockReset().mockResolvedValue({ data: ROLES })
})
afterEach(() => {
  act(() => root?.unmount())
  el?.remove()
  root = null
})

describe('AuthorRolesButton', () => {
  it('puts the confirmed list back and says so when a save fails', async () => {
    h.setAuthorRoles.mockRejectedValue(new Error('Boom'))
    await mountOpen()
    expect(chips()).toEqual(['Role One'])
    await click('button[aria-label="Remove Role One"]')
    await flush()
    expect(chips()).toEqual(['Role One'])
    expect(el.querySelector('[role=alert]')?.textContent).toContain(
      'That change was not saved. Boom'
    )
  })

  it('sends two quick picks one after the other, the second carrying the first', async () => {
    let release: () => void = () => {}
    h.setAuthorRoles
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue({})
    await mountOpen()
    await click('[data-pick="R2"]')
    await click('[data-pick="R3"]')
    expect(h.setAuthorRoles).toHaveBeenCalledTimes(1)
    expect(chips()).toEqual(['Role One', 'Role Two', 'Role Three'])
    await act(async () => release())
    await flush()
    expect(h.setAuthorRoles.mock.calls.map((c) => c[0])).toEqual([
      ['R1', 'R2'],
      ['R1', 'R2', 'R3']
    ])
  })

  it('does not revert past a save still in flight: a failure skips what is queued', async () => {
    let fail: (e: Error) => void = () => {}
    h.setAuthorRoles
      .mockImplementationOnce(() => new Promise<void>((_, rej) => (fail = rej)))
      .mockResolvedValue({})
    await mountOpen()
    await click('[data-pick="R2"]')
    await click('[data-pick="R3"]')
    await act(async () => fail(new Error('Boom')))
    await flush()
    expect(h.setAuthorRoles).toHaveBeenCalledTimes(1)
    expect(chips()).toEqual(['Role One'])
  })

  it('names the remove button "Remove role" while role names load', async () => {
    h.rolesRequest.mockReturnValue(new Promise(() => {}))
    await mountOpen()
    expect(el.querySelector('button[aria-label="Remove role"]')).not.toBeNull()
    expect(el.querySelector('button[aria-label^="Remove Loading"]')).toBeNull()
  })

  it('clears the save error when the popover closes', async () => {
    h.setAuthorRoles.mockRejectedValue(new Error('Boom'))
    await mountOpen()
    await click('button[aria-label="Remove Role One"]')
    await flush()
    expect(el.querySelector('[role=alert]')).not.toBeNull()
    await click('[data-trigger]')
    await click('[data-trigger]')
    await flush()
    expect(el.querySelector('[role=alert]')).toBeNull()
  })
})
