// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { advisoryFixKey, distinctAdvisories } from './MoveAdvisory'
import { PipelinePanel, PipelineTransitionButtons, refusalFixFor } from './PipelinePanel'

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const MESSAGE =
  'Project 201994 has -2.3% of its budget left — only Priority workflows can be approved. Flag this workflow Priority to approve it.'
const ADVISORY = {
  code: 'PRIORITY_REQUIRED',
  message: MESSAGE,
  fix: { action: 'priority', label: 'Flag as Priority' }
}
const STATES = [
  { id: 'S-L1', key: 'l1', label: 'Level 1', color: null, sort: 1 },
  { id: 'S-L2', key: 'l2', label: 'Level 2', color: null, sort: 2 },
  { id: 'S-NEW', key: 'new', label: 'New', color: null, sort: 0 }
]
type Move = Record<string, unknown> & { id: string; label: string }
const MOVES = (blocked: boolean): Move[] => [
  {
    id: 't-approve',
    label: 'Approve',
    from_state: 'S-L1',
    to_state: 'S-L2',
    comment_mode: 'none',
    ...(blocked ? { advisory: ADVISORY } : {})
  },
  {
    id: 't-back',
    label: 'Send Back',
    from_state: 'S-L1',
    to_state: 'S-NEW',
    comment_mode: 'none'
  }
]
const instance = (blocked: boolean, moves: (blocked: boolean) => Move[] = MOVES) => ({
  instance: { id: 'i-1', current_state: 'S-L1', current_state_obj: STATES[0], completed_at: null },
  states: STATES,
  available_transitions: moves(blocked),
  all_transitions: [],
  history: [],
  binding: { id: 1, template: 'tpl', collection: 'workflows', state_field: null }
})

interface Scene {
  /** The moves on offer, given whether the check still refuses. */
  moves?: (blocked: boolean) => Move[]
  /** Panel props. */
  expanded?: boolean
  hideActionsExpanded?: boolean
}

/** `mayFlag`: the registry offers this person the `priority` action. */
function render(ui: 'header' | 'panel', mayFlag: boolean, scene: Scene = {}) {
  const calls: Cmd[] = []
  let flagged = false
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/bulk-actions/available')
        return {
          data: mayFlag
            ? [{ key: 'priority', label: 'Priority', require_reason: true, source: 'db' }]
            : []
        }
      if (cmd._path === '/bulk-actions/run') {
        flagged = true
        return { data: { succeeded: 1 } }
      }
      if (cmd._path.endsWith('/approval-brief')) return { data: { lines: [] } }
      // The open panel's own reads (owners, creator): nothing to show.
      if (cmd._path.endsWith('/owners')) return { data: [] }
      if (cmd._path.endsWith('/owners/all') || cmd._path.endsWith('/creator')) return { data: null }
      if (cmd._path.startsWith('/pipelines/instance/') && cmd._method === 'GET')
        return { data: instance(!flagged, scene.moves) }
      return { data: { ok: true } }
    })
  } as unknown as NivaroClient
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>
          {ui === 'header' ? (
            <PipelineTransitionButtons collection='workflows' item='372967' />
          ) : (
            <PipelinePanel
              collection='workflows'
              item='372967'
              defaultExpanded={scene.expanded}
              hideActionsExpanded={scene.hideActionsExpanded}
            />
          )}
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { calls }
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 60 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 10)))
}
const posts = (calls: Cmd[], end: string) =>
  calls.filter((c) => c._method === 'POST' && c._path.endsWith(end))
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined
const notice = () => document.querySelector('[data-move-advisory]') as HTMLElement | null
const notices = () => [...document.querySelectorAll<HTMLElement>('[data-move-advisory]')]
const mark = (el: Element | null | undefined) => el?.querySelector('[data-move-blocked-mark]')
/** Opens a Radix menu the way a keyboard does (jsdom has no pointer events). */
const openMenu = async (trigger: HTMLElement) => {
  await act(async () => {
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await until(() => !!document.querySelector('[role="menu"]'))
}
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
const type = (el: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('advisory helpers', () => {
  it('the check names its fix; a known code is the fallback; anything else has none', () => {
    expect(advisoryFixKey({ code: 'X', fix: { action: 'flag' } })).toBe('flag')
    expect(advisoryFixKey({ code: 'ON_HOLD' })).toBe('remove-hold')
    expect(advisoryFixKey({ code: 'SOMETHING_ELSE' })).toBeNull()
  })
  it('one notice per distinct reason, with the moves it holds back', () => {
    const held = { code: 'ON_HOLD', message: 'On hold.' }
    const out = distinctAdvisories([
      { id: 'a', advisory: held },
      { id: 'b', advisory: { ...held } },
      { id: 'c' },
      { id: 'd', advisory: ADVISORY }
    ])
    expect(out.map((o) => [o.advisory.code, o.moves.map((m) => m.id)])).toEqual([
      ['ON_HOLD', ['a', 'b']],
      ['PRIORITY_REQUIRED', ['d']]
    ])
  })
  it('a refusal that names its fix offers that action after the press too', () => {
    const err = { response: { code: 'BUDGET_SPENT', fix: { action: 'flag' } } }
    expect(refusalFixFor(err, { transition_id: 't1' })?.actionKey).toBe('flag')
  })
})

describe('header buttons: a move a check would refuse', () => {
  it('is marked before it is pressed, and pressing it shows why instead of sending it', async () => {
    const { calls } = render('header', false)
    await until(() => !!button('Approve'))
    const approve = button('Approve') as HTMLButtonElement
    expect(approve.getAttribute('data-move-blocked')).toBe('PRIORITY_REQUIRED')
    expect(approve.getAttribute('data-tip')).toBe(MESSAGE)
    expect(approve.querySelector('[data-move-blocked-mark]')).not.toBeNull()
    // A move with nothing against it is left alone.
    expect(button('Send Back')?.getAttribute('data-move-blocked')).toBeNull()
    expect(notice()).toBeNull()

    await act(async () => approve.click())
    await until(() => !!notice())
    expect(notice()?.textContent).toContain(MESSAGE)
    expect(posts(calls, '/transition')).toHaveLength(0)
  })

  it('a person who may not clear it gets no action, only the words and a way to close', async () => {
    const { calls } = render('header', false)
    await until(() => !!button('Approve'))
    await act(async () => button('Approve')?.click())
    await until(() => !!button('Close'))
    expect(document.querySelector('[data-move-advisory-run]')).toBeNull()
    expect(document.querySelector('[data-move-advisory-fix]')).toBeNull()
    await act(async () => button('Close')?.click())
    expect(notice()).toBeNull()
    expect(posts(calls, '/bulk-actions/run')).toHaveLength(0)
    expect(posts(calls, '/transition')).toHaveLength(0)
  })

  it('a person who may clear it flags it with a reason, and the move goes on', async () => {
    const { calls } = render('header', true)
    await until(() => !!button('Approve'))
    await act(async () => button('Approve')?.click())
    await until(() => !!button('Flag as Priority, then Approve'))
    const run = button('Flag as Priority, then Approve') as HTMLButtonElement
    // The registry asks for a reason: nothing runs without one.
    expect(run.disabled).toBe(true)
    await act(async () =>
      type(document.querySelector('input[aria-label="Reason"]') as HTMLInputElement, 'Storm repair')
    )
    await act(async () => button('Flag as Priority, then Approve')?.click())
    await until(() => posts(calls, '/transition').length > 0)
    // The existing registry write, on this one record, with the reason.
    expect(posts(calls, '/bulk-actions/run')[0]._body).toEqual({
      collection: 'workflows',
      ids: ['372967'],
      reason: 'Storm repair',
      key: 'priority'
    })
    expect(posts(calls, '/transition')[0]._body).toMatchObject({ transition_id: 't-approve' })
    // The flag came before the move.
    const order = calls.filter((c) => c._method === 'POST').map((c) => c._path)
    expect(order.indexOf('/bulk-actions/run')).toBeLessThan(
      order.findIndex((p) => p.endsWith('/transition'))
    )
  })
})

describe('the Progress panel: the notice sits beside the moves before any press', () => {
  it('shows the check’s words, with the fix for a person who may run it', async () => {
    const { calls } = render('panel', true)
    await until(() => !!notice())
    expect(notice()?.getAttribute('role')).toBe('note')
    expect(notice()?.textContent).toContain(MESSAGE)
    await until(() => !!button('Flag as Priority'))
    await act(async () => button('Flag as Priority')?.click())
    await act(async () =>
      type(document.querySelector('input[aria-label="Reason"]') as HTMLInputElement, 'Storm repair')
    )
    await act(async () => button('Flag as Priority')?.click())
    await until(() => posts(calls, '/bulk-actions/run').length > 0)
    // Flagging alone never moves the record; the notice goes once the check passes.
    await until(() => !notice())
    expect(notice()).toBeNull()
    expect(posts(calls, '/transition')).toHaveLength(0)
  })

  it('shows the words alone to a person who may not', async () => {
    render('panel', false)
    await until(() => !!notice())
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(notice()?.textContent).toContain(MESSAGE)
    expect(notice()?.querySelector('button')).toBeNull()
  })
})

// ── Design review round 1, item 3 ─────────────────────────────────────────────

const HOLD = { code: 'ON_HOLD', message: 'This workflow is on hold. Take the hold off to move it.' }
/** Approve needs Priority; Close out is held: two reasons at once. */
const TWO_REASONS = (blocked: boolean): Move[] => [
  ...MOVES(blocked),
  {
    id: 't-close',
    label: 'Close out',
    from_state: 'S-L1',
    to_state: 'S-L2',
    comment_mode: 'none',
    advisory: HOLD
  }
]
/** Approve green and blocked, Send Back red and free. */
const COLOURED = (blocked: boolean): Move[] =>
  MOVES(blocked).map((m) => ({ ...m, color: m.id === 't-approve' ? '#16a34a' : '#dc2626' }))
/** "Send Back" to two steps (one menu); `both` = a check refuses each of them. */
const GROUPED =
  (both: boolean) =>
  (blocked: boolean): Move[] => [
    MOVES(blocked)[0],
    { ...MOVES(blocked)[1], id: 't-back-new', advisory: HOLD },
    {
      ...MOVES(blocked)[1],
      id: 't-back-l2',
      to_state: 'S-L2',
      ...(both ? { advisory: HOLD } : {})
    }
  ]

describe('the Progress panel, open: the notice sits with the moves it is about', () => {
  it('directly above the move buttons, as its own card', async () => {
    render('panel', false, { expanded: true })
    await until(() => !!notice() && !!button('Approve'))
    expect(notices()).toHaveLength(1)
    expect(notice()?.nextElementSibling).toBe(button('Approve')?.parentElement)
    expect(notice()?.className).toContain('rounded-lg')
    expect(notice()?.className).not.toContain('border-t')
  })

  it('folded, it stays under the header', async () => {
    render('panel', false)
    await until(() => !!notice())
    expect(notice()?.className).toContain('border-t')
    expect(notice()?.className).not.toContain('rounded-lg')
  })

  it('open with its buttons hidden (the header hosts them), it stays under the header', async () => {
    render('panel', false, { expanded: true, hideActionsExpanded: true })
    await until(() => !!notice())
    expect(notice()?.className).toContain('border-t')
  })
})

describe('a pressed move a person cannot clear', () => {
  it('lights up its notice and brings it into view', async () => {
    const intoView = vi.fn()
    Element.prototype.scrollIntoView = intoView
    render('panel', false, { expanded: true })
    await until(() => !!notice() && !!button('Approve'))
    expect(notice()?.className).not.toContain('ring-amber-400')
    expect(intoView).not.toHaveBeenCalled()

    await act(async () => button('Approve')?.click())
    await until(() => notice()?.getAttribute('role') === 'status')
    expect(notice()?.className).toContain('ring-1')
    expect(notice()?.className).toContain('ring-amber-400')
    expect(intoView).toHaveBeenCalledWith({ block: 'nearest' })
  })
})

describe('two reasons at once', () => {
  it('each notice names the moves it stops', async () => {
    render('panel', false, { moves: TWO_REASONS })
    await until(() => notices().length === 2)
    const byCode = (code: string) => notices().find((n) => n.dataset.moveAdvisory === code)
    expect(byCode('PRIORITY_REQUIRED')?.textContent).toContain('Stops: Approve')
    expect(byCode('ON_HOLD')?.textContent).toContain('Stops: Close out')
  })

  it('one reason says nothing more: the mark is on its only move', async () => {
    render('panel', false)
    await until(() => !!notice())
    expect(notice()?.textContent).not.toContain('Stops:')
  })
})

describe('a blocked move’s own button', () => {
  for (const ui of ['panel', 'header'] as const)
    it(`${ui}: drops its action colour for the amber outline, keeps the mark and stays enabled`, async () => {
      render(ui, false, { moves: COLOURED })
      await until(() => !!button('Approve'))
      const approve = button('Approve') as HTMLButtonElement
      expect(approve.style.color).toBe('')
      expect(approve.style.borderColor).toBe('')
      expect(approve.className).toContain('border-amber-300')
      expect(approve.className).toContain('text-slate-700')
      expect(mark(approve)).not.toBeNull()
      expect(approve.disabled).toBe(false)
      // A move with nothing against it keeps its colour.
      expect(button('Send Back')?.style.color).not.toBe('')
      expect(button('Send Back')?.className).not.toContain('border-amber-300')
    })
})

describe('moves in a menu', () => {
  for (const ui of ['panel', 'header'] as const)
    it(`${ui}: the reason is a line under the items, not a tip over them`, async () => {
      render(ui, false, { moves: GROUPED(false), expanded: true })
      await until(() => !!button('Send Back'))
      await openMenu(button('Send Back') as HTMLButtonElement)
      const blocked = menuItems().filter((i) => i.hasAttribute('data-move-blocked'))
      expect(blocked).toHaveLength(1)
      expect(blocked[0].hasAttribute('data-tip')).toBe(false)
      expect(blocked[0].getAttribute('aria-description')).toBe(HOLD.message)
      const note = document.querySelector('[data-move-blocked-note]') as HTMLElement
      expect(note.textContent).toBe(HOLD.message)
      expect(note.closest('[role="menu"]')).not.toBeNull()
      expect(mark(note)).not.toBeNull()
    })

  for (const ui of ['panel', 'header'] as const)
    it(`${ui}: the menu’s own button is marked only when every move inside is blocked`, async () => {
      render(ui, false, { moves: GROUPED(true) })
      await until(() => !!button('Send Back'))
      expect(mark(button('Send Back'))).not.toBeNull()
      act(() => root.unmount())
      root = createRoot(host)
      render(ui, false, { moves: GROUPED(false) })
      await until(() => !!button('Send Back'))
      expect(mark(button('Send Back'))).toBeNull()
    })
})

describe('what the fix says when it is done', () => {
  it('a move that then goes on by itself: only that the fix is done', async () => {
    const said = vi.spyOn(toast, 'success')
    const { calls } = render('header', true)
    await until(() => !!button('Approve'))
    await act(async () => button('Approve')?.click())
    await until(() => !!button('Flag as Priority, then Approve'))
    await act(async () =>
      type(document.querySelector('input[aria-label="Reason"]') as HTMLInputElement, 'Storm repair')
    )
    await act(async () => button('Flag as Priority, then Approve')?.click())
    await until(() => posts(calls, '/transition').length > 0 && said.mock.calls.length > 0)
    expect(said.mock.calls[0][0]).toBe('Done: Flag as Priority.')
  })

  it('a move that asks first: the fix is done, and the move is still to confirm', async () => {
    const said = vi.spyOn(toast, 'success')
    const { calls } = render('header', true, {
      moves: (blocked) =>
        MOVES(blocked).map((m) => (m.id === 't-approve' ? { ...m, comment_mode: 'required' } : m))
    })
    await until(() => !!button('Approve'))
    await act(async () => button('Approve')?.click())
    await until(() => !!button('Flag as Priority, then Approve'))
    await act(async () =>
      type(document.querySelector('input[aria-label="Reason"]') as HTMLInputElement, 'Storm repair')
    )
    await act(async () => button('Flag as Priority, then Approve')?.click())
    // The confirm step and the toast come from the same answer, in either order.
    await until(() => !!button('Confirm') && said.mock.calls.length > 0)
    expect(said.mock.calls[0][0]).toBe('Done: Flag as Priority. Confirm Approve to finish.')
    // Nothing was sent: the confirm is still the person's to press.
    expect(posts(calls, '/transition')).toHaveLength(0)
  })

  it('the fix on its own, with no move pressed', async () => {
    const said = vi.spyOn(toast, 'success')
    const { calls } = render('panel', true)
    await until(() => !!button('Flag as Priority'))
    await act(async () => button('Flag as Priority')?.click())
    await act(async () =>
      type(document.querySelector('input[aria-label="Reason"]') as HTMLInputElement, 'Storm repair')
    )
    await act(async () => button('Flag as Priority')?.click())
    await until(() => posts(calls, '/bulk-actions/run').length > 0 && said.mock.calls.length > 0)
    expect(said.mock.calls[0][0]).toBe('Done: Flag as Priority.')
  })
})
