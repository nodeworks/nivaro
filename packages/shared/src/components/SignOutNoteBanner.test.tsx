// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../context'
import {
  parseSignOutNote,
  readSignOutNote,
  SIGN_OUT_NOTE_KEY,
  saveSignOutNote,
  signOutNoteHeading
} from '../lib/sign-out-note'
import { SignOutNoteAfterSignIn, SignOutNoteBanner } from './SignOutNoteBanner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Rob 2026-11-10: a message left when signing someone out must be CLEAR and stay
// on the sign-in page for a person away from their desk.

const NOTE = {
  user_id: 'AAAAAAAA-0000-4000-8000-000000000002',
  message: 'Laptop left unlocked — call the help desk',
  by_name: 'Rob Lee',
  at: new Date(Date.now() - 60_000).toISOString()
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('sign-out note helpers', () => {
  it('parses only a real note; saves and reads it back', () => {
    expect(parseSignOutNote(null)).toBeNull()
    expect(parseSignOutNote({ message: '  ', at: NOTE.at })).toBeNull()
    expect(parseSignOutNote({ message: 'x', at: 'not a date' })).toBeNull()
    expect(parseSignOutNote({ message: ' hi ', at: NOTE.at })).toEqual({
      user_id: null,
      message: 'hi',
      by_name: null,
      at: NOTE.at
    })
    saveSignOutNote(NOTE)
    expect(readSignOutNote()).toEqual(NOTE)
  })

  it('heading: 12-hour time today, the date on another day, a fallback name', () => {
    const at = new Date(NOTE.at)
    const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    expect(signOutNoteHeading(NOTE, at)).toBe(`Signed out by Rob Lee at ${time}`)
    const later = new Date(at.getTime() + 3 * 86400_000)
    expect(signOutNoteHeading({ ...NOTE, by_name: null }, later)).toMatch(
      new RegExp(`^Signed out by an administrator on \\w{3} \\d{1,2} at ${time}$`)
    )
  })
})

it('a note older than the server keeps it (14 days) is dropped', () => {
  saveSignOutNote({ ...NOTE, at: new Date(Date.now() - 15 * 86400_000).toISOString() })
  expect(readSignOutNote()).toBeNull()
  expect(localStorage.getItem(SIGN_OUT_NOTE_KEY)).toBeNull()
})

describe('SignOutNoteBanner (sign-in page)', () => {
  it('shows nothing without a note', () => {
    act(() => root.render(<SignOutNoteBanner />))
    expect(host.querySelector('[data-sign-out-note]')).toBeNull()
  })

  it('shows a stored note — it survives a reload (read on mount)', () => {
    localStorage.setItem(SIGN_OUT_NOTE_KEY, JSON.stringify(NOTE))
    act(() => root.render(<SignOutNoteBanner />))
    const el = host.querySelector('[data-sign-out-note]')
    expect(el?.getAttribute('role')).toBe('alert')
    expect(el?.textContent).toContain('Laptop left unlocked — call the help desk')
    expect(el?.textContent).toContain('Signed out by Rob Lee')
  })

  it('appears the moment the socket keeps a note (already on the sign-in page)', () => {
    act(() => root.render(<SignOutNoteBanner />))
    act(() => saveSignOutNote(NOTE))
    expect(host.querySelector('[data-sign-out-note]')?.textContent).toContain('call the help desk')
  })
})

describe('SignOutNoteAfterSignIn', () => {
  function client(serverNote: unknown) {
    const calls: Array<{ method: string; path: string }> = []
    return {
      calls,
      request: vi.fn(async (cmd: { _method?: string; _path?: string }) => {
        calls.push({ method: String(cmd._method ?? 'GET'), path: String(cmd._path ?? '') })
        return cmd._method === 'DELETE' ? undefined : { data: serverNote }
      })
    }
  }
  const flush = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

  it('a note only the server holds (no tab was open) is shown once; Got it clears it', async () => {
    const c = client(NOTE)
    act(() =>
      root.render(
        <NivaroProvider client={c as never}>
          <SignOutNoteAfterSignIn />
        </NivaroProvider>
      )
    )
    await flush()
    const el = host.querySelector('[data-sign-out-note-after]')
    expect(el?.textContent).toContain('call the help desk')
    act(() => (el?.querySelector('button') as HTMLButtonElement).click())
    expect(host.querySelector('[data-sign-out-note-after]')).toBeNull()
    expect(
      c.calls.some((x) => x.method === 'DELETE' && x.path.includes('/security/my/sign-out-note'))
    ).toBe(true)
  })

  it('a note the sign-in page already showed is cleared quietly, not shown again', async () => {
    saveSignOutNote(NOTE)
    const c = client(NOTE)
    act(() =>
      root.render(
        <NivaroProvider client={c as never}>
          <SignOutNoteAfterSignIn />
        </NivaroProvider>
      )
    )
    await flush()
    expect(host.querySelector('[data-sign-out-note-after]')).toBeNull()
    expect(readSignOutNote()).toBeNull()
    expect(c.calls.some((x) => x.method === 'DELETE')).toBe(true)
  })

  it('no note on the server: nothing shown, the local copy is gone', async () => {
    saveSignOutNote(NOTE)
    const c = client(null)
    act(() =>
      root.render(
        <NivaroProvider client={c as never}>
          <SignOutNoteAfterSignIn />
        </NivaroProvider>
      )
    )
    await flush()
    expect(host.querySelector('[data-sign-out-note-after]')).toBeNull()
    expect(readSignOutNote()).toBeNull()
  })
})

describe('a different person signs in on the same browser', () => {
  function client(serverNote: unknown) {
    return {
      request: vi.fn(async (cmd: { _method?: string }) =>
        cmd._method === 'DELETE' ? undefined : { data: serverNote }
      )
    }
  }
  const flush = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

  it("A's note left on the browser is never shown to B, and is cleared", async () => {
    saveSignOutNote(NOTE) // A was signed out with a message on this browser
    act(() =>
      root.render(
        <NivaroProvider client={client(null) as never}>
          <SignOutNoteAfterSignIn />
        </NivaroProvider>
      )
    )
    await flush()
    expect(host.querySelector('[data-sign-out-note-after]')).toBeNull()
    expect(readSignOutNote()).toBeNull()
  })

  it("B with a note of their own sees theirs, never A's", async () => {
    saveSignOutNote(NOTE)
    const mine = { ...NOTE, user_id: 'BBBBBBBB-0000-4000-8000-000000000003', message: 'B: see IT' }
    act(() =>
      root.render(
        <NivaroProvider client={client(mine) as never}>
          <SignOutNoteAfterSignIn />
        </NivaroProvider>
      )
    )
    await flush()
    const el = host.querySelector('[data-sign-out-note-after]')
    expect(el?.textContent).toContain('B: see IT')
    expect(el?.textContent).not.toContain('Laptop left unlocked')
    expect(readSignOutNote()).toBeNull()
  })
})
