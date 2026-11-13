// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { UserScopesCard } from './PersonAccess'

// Rob 2026-11-13: "Apply restriction is slow, doesn't update the UI right
// away and is clunky and confusing." The card now applies optimistically,
// rolls back on failure, previews once per burst of clicks and never lets an
// older preview overwrite a newer one.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn(), warning: vi.fn() })
}))

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const USER = 'u-1'
const REGIONS = [
  { id: 1, short_name: 'East' },
  { id: 2, short_name: 'West' },
  { id: 3, short_name: 'North' }
]

let server: { defaults: Record<string, number[]>; restricted: Record<string, number[]> }
let calls: Cmd[] = []
let putGate: Deferred<unknown> | null = null
let impactQueue: Array<Deferred<unknown>> = []
let root: Root
let host: HTMLDivElement

function impactAnswer(proposed: number[], workflows: number) {
  return {
    data: {
      dimension: 'region',
      current_values: server.restricted.region ?? [],
      proposed_values: proposed,
      impact: [
        {
          collection: 'workflows',
          label: 'Workflows',
          total: 1000,
          current: 300,
          proposed: workflows,
          gained: Math.max(0, workflows - 300),
          lost: Math.max(0, 300 - workflows),
          gained_sample: workflows > 300 ? [{ id: '9', label: 'FU26-81410' }] : [],
          lost_sample: workflows < 300 ? [{ id: '8', label: 'BT23-47018' }] : []
        }
      ],
      partial: []
    }
  }
}

async function settle(until?: () => boolean, rounds = 80) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => await new Promise((r) => setTimeout(r, 5)))
    if (until?.()) return
  }
}

beforeEach(async () => {
  calls = []
  putGate = null
  impactQueue = []
  toastError.mockClear()
  server = { defaults: {}, restricted: { region: [1] } }
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._method === 'GET' && cmd._path === `/user-scopes/${USER}`)
        return {
          data: {
            dimensions: [
              {
                name: 'region',
                label: 'Region',
                target_collection: 'regions',
                display_field: 'short_name',
                options_sort: null
              }
            ],
            defaults: { ...server.defaults },
            restricted: { ...server.restricted }
          }
        }
      if (cmd._path.startsWith('/items/regions')) return { data: REGIONS }
      if (cmd._method === 'POST' && cmd._path === `/user-scopes/${USER}/impact`) {
        const d = deferred<unknown>()
        impactQueue.push(d)
        return d.promise
      }
      if (cmd._method === 'PUT' && cmd._path === `/user-scopes/${USER}`) {
        if (putGate) await putGate.promise
        const b = cmd._body as { dimension: string; mode: string; values: number[] }
        if (b.mode === 'restrict') server.restricted[b.dimension] = b.values
        else server.defaults[b.dimension] = b.values
        return { data: { saved: true, values: b.values } }
      }
      throw new Error(`unexpected ${cmd._method} ${cmd._path}`)
    })
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NivaroProvider client={client as never}>
          <UserScopesCard userId={USER} previewDelayMs={20} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => !!restrictPill('West'))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const restrictPill = (label: string) =>
  [...host.querySelectorAll('[data-scope-restrict="region"] button')].find(
    (b) => b.textContent?.trim() === label
  ) as HTMLButtonElement | undefined
const defaultPill = (label: string) =>
  [...host.querySelectorAll('[data-scope-defaults="region"] button')].find(
    (b) => b.textContent?.trim() === label
  ) as HTMLButtonElement | undefined
const pressed = (el?: HTMLButtonElement) => el?.getAttribute('aria-pressed') === 'true'
const applyBtn = () => host.querySelector('[data-scope-apply]') as HTMLButtonElement | null
const preview = () => host.querySelector('[data-scope-preview]') as HTMLElement | null
const click = async (el: Element | null | undefined) => {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}
const impactCalls = () => calls.filter((c) => c._path.endsWith('/impact'))

describe('UserScopesCard — restrictions', () => {
  it('a burst of clicks asks for ONE preview, of the last selection', async () => {
    await click(restrictPill('West'))
    await click(restrictPill('North'))
    // the pills follow the draft at once
    expect(pressed(restrictPill('West'))).toBe(true)
    expect(pressed(restrictPill('North'))).toBe(true)
    await settle(() => impactCalls().length > 0)
    await settle(undefined, 8)
    expect(impactCalls()).toHaveLength(1)
    expect(impactCalls()[0]._body).toEqual({ dimension: 'region', values: [1, 2, 3] })
  })

  it('an older preview that answers late never replaces a newer one', async () => {
    await click(restrictPill('West'))
    await settle(() => impactQueue.length === 1)
    await click(restrictPill('North'))
    await settle(() => impactQueue.length === 2)
    // the newer answer first, then the older one
    await act(async () => impactQueue[1].resolve(impactAnswer([1, 2, 3], 900)))
    await settle(() => preview()?.textContent?.includes('900') ?? false)
    await act(async () => impactQueue[0].resolve(impactAnswer([1, 2], 600)))
    await settle(undefined, 6)
    expect(preview()?.textContent).toContain('900')
    expect(preview()?.textContent).not.toContain('600 of')
  })

  it('keeps the last preview on screen while a new one is worked out, and holds Apply', async () => {
    await click(restrictPill('West'))
    await settle(() => impactQueue.length === 1)
    await act(async () => impactQueue[0].resolve(impactAnswer([1, 2], 600)))
    await settle(() => !!applyBtn() && !applyBtn()?.disabled)
    await click(restrictPill('North'))
    await settle(undefined, 2)
    expect(preview()?.textContent).toContain('600')
    expect(preview()?.getAttribute('data-scope-preview')).toBe('updating')
    expect(applyBtn()?.disabled).toBe(true)
  })

  it('Apply shows the new values at once, says Saving, then Saved', async () => {
    await click(restrictPill('West'))
    await settle(() => impactQueue.length === 1)
    await act(async () => impactQueue[0].resolve(impactAnswer([1, 2], 600)))
    await settle(() => !!applyBtn() && !applyBtn()?.disabled)
    putGate = deferred()
    await click(applyBtn())
    // before the server answered: new state on screen, nothing clickable twice
    expect(pressed(restrictPill('West'))).toBe(true)
    expect(pressed(restrictPill('East'))).toBe(true)
    expect(host.querySelector('[data-scope-status="region:restrict"]')?.textContent).toMatch(
      /Saving/
    )
    expect(preview()).toBeNull()
    await act(async () => putGate?.resolve(undefined))
    await settle(() =>
      /Saved/.test(host.querySelector('[data-scope-status="region:restrict"]')?.textContent ?? '')
    )
    expect(pressed(restrictPill('West'))).toBe(true)
    const put = calls.find((c) => c._method === 'PUT')
    expect(put?._body).toEqual({ dimension: 'region', mode: 'restrict', values: [1, 2] })
  })

  it('a failed Apply puts the old values back and says so', async () => {
    await click(restrictPill('West'))
    await settle(() => impactQueue.length === 1)
    await act(async () => impactQueue[0].resolve(impactAnswer([1, 2], 600)))
    await settle(() => !!applyBtn() && !applyBtn()?.disabled)
    putGate = deferred()
    await click(applyBtn())
    expect(pressed(restrictPill('West'))).toBe(true)
    await act(async () => putGate?.reject(Object.assign(new Error('boom'), { status: 500 })))
    await settle(() => !pressed(restrictPill('West')))
    expect(pressed(restrictPill('West'))).toBe(false)
    expect(pressed(restrictPill('East'))).toBe(true)
    expect(toastError).toHaveBeenCalled()
  })

  it('going back to the saved selection closes the preview', async () => {
    await click(restrictPill('West'))
    await settle(() => !!preview())
    await click(restrictPill('West'))
    await settle(undefined, 4)
    expect(preview()).toBeNull()
  })

  it('says plainly what changes, with the collection label, never the table name', async () => {
    await click(restrictPill('West'))
    await settle(() => impactQueue.length === 1)
    await act(async () => impactQueue[0].resolve(impactAnswer([1, 2], 600)))
    await settle(() => !!applyBtn() && !applyBtn()?.disabled)
    const text = preview()?.textContent ?? ''
    expect(text).toContain('West')
    expect(text).toContain('Workflows')
    expect(text).not.toContain('workflows:')
    expect(text).toContain('+300')
    expect(text).toContain('FU26-81410')
  })
})

describe('UserScopesCard — defaults', () => {
  it('a default toggles at once and rolls back when the save fails', async () => {
    putGate = deferred()
    await click(defaultPill('North'))
    expect(pressed(defaultPill('North'))).toBe(true)
    expect(host.querySelector('[data-scope-status="region:default"]')?.textContent).toMatch(
      /Saving/
    )
    await act(async () => putGate?.reject(new Error('nope')))
    await settle(() => !pressed(defaultPill('North')))
    expect(pressed(defaultPill('North'))).toBe(false)
    expect(toastError).toHaveBeenCalled()
  })

  it('a failed save says so until the next change, and Retry sends it again', async () => {
    putGate = deferred()
    await click(defaultPill('North'))
    await act(async () => putGate?.reject(new Error('nope')))
    const chip = () => host.querySelector('[data-scope-status="region:default"]')
    await settle(() => /Not saved/.test(chip()?.textContent ?? ''))
    await settle(undefined, 10)
    expect(chip()?.textContent).toMatch(/Not saved/)
    putGate = null
    await click(
      [...(chip()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Retry')
    )
    await settle(() => pressed(defaultPill('North')) && /Saved/.test(chip()?.textContent ?? ''))
    expect(calls.filter((c) => c._method === 'PUT')).toHaveLength(2)
    expect(pressed(defaultPill('North'))).toBe(true)
  })
})
