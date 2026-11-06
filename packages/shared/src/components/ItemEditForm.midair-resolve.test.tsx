// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { CMSField } from './item-edit/types'

// army5 b09 BLOCKER: two people edit the same header field; the second save
// gets the mid-air dialog. With THEIRS picked (the default) "Apply & save"
// wrote MINE over the newer save — the retry read a stale draft while it sent
// the NEWER base revision, so the server's mid-air check passed.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn()
  })
}))

function field(name: string, label: string): CMSField {
  return {
    field: name,
    type: 'text',
    interface: 'input',
    label,
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: 'basic',
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

type Cmd = { _method?: string; _path: string; _body?: Record<string, unknown> }

/** A server with the real mid-air rule: a PATCH naming a field someone saved
 *  after `_base_revision` is refused 409 MIDAIR_COLLISION. */
function makeServer(opts: { draft?: Record<string, unknown> } = {}) {
  const calls: Cmd[] = []
  const row: Record<string, unknown> = { id: 1, description: 'A', title: 'T' }
  let rev = 10
  const changedAt: Record<string, number> = {}
  const client = {
    url: 'http://test',
    getToken: () => null,
    /** Someone else's save (another tab / person). */
    otherSave(values: Record<string, unknown>) {
      rev++
      Object.assign(row, values)
      for (const k of Object.keys(values)) changedAt[k] = rev
    },
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      const method = (cmd._method ?? 'GET').toUpperCase()
      if (p === '/collection-layouts/active')
        return {
          data: {
            layout: { id: 7, name: 'Workflow', slug: 'workflow' },
            groups: [{ id: 1, key: 'basic', label: 'Basic Info', type: 'tab', icon: null, sort: 0 }],
            assignments: [
              { field: 'description', sort: 0, group_key: 'basic', is_visible: true },
              { field: 'title', sort: 1, group_key: 'basic', is_visible: true }
            ],
            ungrouped_sort: 99
          }
        }
      if (p === '/field-config/workflows')
        return { data: [field('description', 'Description'), field('title', 'Title')] }
      if (p === '/collections/workflows') return { data: { display_name: 'Workflows' } }
      if (p === '/revisions') return { data: { latest: rev } }
      if (p === '/drafts/workflows/1' && method === 'GET') {
        if (!opts.draft) throw Object.assign(new Error('404'), { status: 404 })
        return { data: { payload: opts.draft, saved_at: opts.draft.saved_at } }
      }
      if (p === '/items/workflows/1' && method === 'GET') return { data: { ...row } }
      if (p === '/items/workflows/1' && method === 'PATCH') {
        const body = cmd._body ?? {}
        const base = Number(body._base_revision ?? 0)
        const fields = Object.keys(body).filter((k) => !k.startsWith('_'))
        const conflicts = fields
          .filter((k) => (changedAt[k] ?? 0) > base)
          .map((k) => ({ field: k, current_value: row[k] }))
        if (conflicts.length > 0) {
          throw Object.assign(new Error('Request failed with status 409'), {
            status: 409,
            response: {
              code: 'MIDAIR_COLLISION',
              message: 'Someone else changed this record since you loaded it',
              conflicts,
              latest_revision: rev
            }
          })
        }
        rev++
        for (const k of fields) {
          row[k] = body[k]
          changedAt[k] = rev
        }
        return { data: { ...row } }
      }
      if (p.startsWith('/record-views/')) return { data: null }
      if (method !== 'GET') return { data: { id: 1 } }
      return { data: [] }
    })
  }
  return { client, calls, row }
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

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.mocked(toast.success).mockClear()
  vi.mocked(toast.warning).mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function settle(until: () => boolean, rounds = 100) {
  for (let i = 0; i < rounds && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const input = (f: string) =>
  host.querySelector(`[data-field="${f}"] input`) as HTMLInputElement | null

async function type(f: string, value: string) {
  const el = input(f) as HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    set?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function mount(opts: { draft?: Record<string, unknown> } = {}) {
  const server = makeServer(opts)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let save: (() => void) | null = null
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={server.client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'U1' }}>
            <ItemEditForm
              collection='workflows'
              itemId='1'
              documentTitle={false}
              registerSaveHandler={(fn) => {
                save = fn
              }}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(() => input('description')?.value === 'A' && input('title')?.value === 'T')
  return { ...server, qc, save: () => save?.() }
}

const patches = (calls: Cmd[]) => calls.filter((c) => (c._method ?? '').toUpperCase() === 'PATCH')
const dialog = () =>
  [...document.querySelectorAll('[role="dialog"]')].find((d) =>
    d.textContent?.includes('Someone else changed this record')
  ) as HTMLElement | undefined
const dialogButton = (text: string, scope?: Element | null) =>
  [...(scope ?? dialog() ?? document).querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text)
  ) as HTMLButtonElement | undefined
/** The Mine card of one conflicting field (by its label). */
function pickMine(label: string) {
  const card = [...(dialog()?.querySelectorAll('div.rounded-md') ?? [])].find(
    (d) => d.querySelector('p')?.textContent === label
  )
  const btn = dialogButton('Mine (overwrite)', card)
  expect(btn).toBeTruthy()
  act(() => btn?.click())
}

/** Edit, let the form read its base revision, then someone else saves, then
 *  this tab saves and meets the mid-air dialog. */
async function collide(
  mine: Record<string, string>,
  theirs: Record<string, string>
): Promise<Awaited<ReturnType<typeof mount>>> {
  const m = await mount()
  for (const [f, v] of Object.entries(mine)) await type(f, v)
  await settle(() => m.calls.some((c) => c._path === '/revisions'))
  m.client.otherSave(theirs)
  await act(async () => m.save())
  await settle(() => !!dialog())
  expect(dialog()).toBeTruthy()
  expect(patches(m.calls)).toHaveLength(1)
  return m
}

async function applyAndSettle(m: Awaited<ReturnType<typeof mount>>, patchesWanted: number) {
  await act(async () => dialogButton('Apply & save')?.click())
  await settle(() => patches(m.calls).length >= patchesWanted && !dialog(), 60)
  // Let any (wrong) retry land too, and the closing toast (shown ~1.2 s
  // after the save dialog's success state).
  await settle(() => vi.mocked(toast.success).mock.calls.length > 0, 250)
  await settle(() => false, 10)
}

describe('ItemEditForm header mid-air dialog (army5 b09)', () => {
  it('THEIRS (the default) keeps their value: no field is written over', async () => {
    const m = await collide({ description: 'A S2' }, { description: 'A B4' })
    await applyAndSettle(m, 1)
    // Nothing of the person's is left to write → no second PATCH at all.
    expect(patches(m.calls)).toHaveLength(1)
    expect(m.row.description).toBe('A B4')
    expect(input('description')?.value).toBe('A B4')
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Kept the newer value — nothing of yours left to save'
    )
  })

  it('THEIRS with another edit: the retry carries only the other field, on the new base', async () => {
    const m = await collide({ description: 'A S2', title: 'T2' }, { description: 'A B4' })
    const firstBase = patches(m.calls)[0]._body?._base_revision
    await applyAndSettle(m, 2)
    const ps = patches(m.calls)
    expect(ps).toHaveLength(2)
    const body = ps[1]._body ?? {}
    expect(body).not.toHaveProperty('description')
    expect(body.title).toBe('T2')
    expect(body._base_revision).toBe(11)
    expect(body._base_revision).not.toBe(firstBase)
    expect(m.row.description).toBe('A B4')
    expect(m.row.title).toBe('T2')
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Changes saved — kept the newer value for 1 field'
    )
  })

  it('MINE sends mine against the new base and overwrites deliberately', async () => {
    const m = await collide({ description: 'A S2' }, { description: 'A B4' })
    pickMine('Description')
    await applyAndSettle(m, 2)
    const ps = patches(m.calls)
    expect(ps).toHaveLength(2)
    expect(ps[1]._body?.description).toBe('A S2')
    expect(ps[1]._body?._base_revision).toBe(11)
    expect(m.row.description).toBe('A S2')
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Changes saved')
  })

  it('a mix works per field: theirs kept for one, mine written for the other', async () => {
    const m = await collide(
      { description: 'A S2', title: 'T S2' },
      { description: 'A B4', title: 'T B4' }
    )
    pickMine('Title')
    await applyAndSettle(m, 2)
    const ps = patches(m.calls)
    expect(ps).toHaveLength(2)
    const body = ps[1]._body ?? {}
    expect(body).not.toHaveProperty('description')
    expect(body.title).toBe('T S2')
    expect(body._base_revision).toBe(11)
    expect(m.row.description).toBe('A B4')
    expect(m.row.title).toBe('T S2')
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      'Changes saved — kept the newer value for 1 field'
    )
  })
})

// army5 b09 HIGH: "Restore your unsaved changes" put an old draft over a
// newer save by someone else, and Save wrote it with no conflict check.
function storedDraft(extra: Record<string, unknown>) {
  return {
    key: 'workflows:1:U1',
    collection: 'workflows',
    item_id: '1',
    user_id: 'U1',
    saved_at: new Date(Date.now() - 120_000).toISOString(),
    fields: { description: 'A S3' },
    base: { description: 'A' },
    base_updated_at: null,
    pending_rows: {},
    pending_edits: {},
    pending_deletes: {},
    m2m_links: {},
    m2m_unlinks: {},
    ...extra
  }
}
const restoreButton = () =>
  host.querySelector('[data-nvr-draft-restore]') as HTMLButtonElement | null

/** Open the record with a stored draft; someone else saved `theirs` after
 *  the draft was taken (before this open). */
async function openWithDraft(draft: Record<string, unknown>, theirs?: Record<string, unknown>) {
  const server = makeServer({ draft })
  if (theirs) server.client.otherSave(theirs)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let save: (() => void) | null = null
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={server.client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'U1' }}>
            <ItemEditForm
              collection='workflows'
              itemId='1'
              documentTitle={false}
              registerSaveHandler={(fn) => {
                save = fn
              }}
            />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(() => !!restoreButton())
  expect(restoreButton()).toBeTruthy()
  await act(async () => restoreButton()?.click())
  await settle(() => input('description')?.value === 'A S3')
  await settle(() => server.calls.some((c) => c._path === '/revisions'))
  return { ...server, qc, save: () => save?.() }
}

describe('ItemEditForm restored draft vs a newer save (army5 b09)', () => {
  it('flags the field on restore and Save asks Theirs / Mine before writing anything', async () => {
    const m = await openWithDraft(storedDraft({}), { description: 'A B5' })
    expect(vi.mocked(toast.warning)).toHaveBeenCalled()
    expect(host.querySelector('[data-remote-take-theirs]')).toBeTruthy()
    await act(async () => m.save())
    await settle(() => !!dialog())
    expect(dialog()).toBeTruthy()
    // Stopped on the client: no write at all yet.
    expect(patches(m.calls)).toHaveLength(0)
    await applyAndSettle(m, 0)
    expect(patches(m.calls)).toHaveLength(0)
    expect(m.row.description).toBe('A B5')
    expect(input('description')?.value).toBe('A B5')
  })

  it('Mine after a stale restore overwrites deliberately, on the current base', async () => {
    const m = await openWithDraft(storedDraft({ base_revision: 10 }), { description: 'A B5' })
    await act(async () => m.save())
    await settle(() => !!dialog())
    pickMine('Description')
    await applyAndSettle(m, 1)
    const ps = patches(m.calls)
    expect(ps).toHaveLength(1)
    expect(ps[0]._body?.description).toBe('A S3')
    expect(ps[0]._body?._base_revision).toBe(11)
    expect(m.row.description).toBe('A S3')
  })

  it('a draft with no field base still saves against its own revision (server 409)', async () => {
    const m = await openWithDraft(storedDraft({ base: {}, base_revision: 10 }), {
      description: 'A B5'
    })
    await act(async () => m.save())
    await settle(() => !!dialog())
    expect(dialog()).toBeTruthy()
    const ps = patches(m.calls)
    expect(ps).toHaveLength(1)
    expect(ps[0]._body?._base_revision).toBe(10)
    expect(m.row.description).toBe('A B5')
  })

  it('a draft nobody else overtook restores and saves normally', async () => {
    const m = await openWithDraft(storedDraft({ base_revision: 10 }))
    expect(vi.mocked(toast.warning)).not.toHaveBeenCalled()
    await act(async () => m.save())
    await settle(() => patches(m.calls).length > 0)
    expect(dialog()).toBeFalsy()
    expect(patches(m.calls)[0]._body?.description).toBe('A S3')
    expect(m.row.description).toBe('A S3')
  })
})
