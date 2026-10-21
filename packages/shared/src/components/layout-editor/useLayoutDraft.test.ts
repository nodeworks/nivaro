// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  applyLayoutOps,
  type GroupRow,
  type LayoutBundle,
  type LayoutOp,
  newGroup,
  newPlacement,
  type PlacementRow,
  ungroupedGroup
} from '../../lib/layout-ops'
import {
  inverseOps,
  type LayoutDraft,
  type LayoutDraftOptions,
  partlyRebasedMessage,
  rebasedMessage,
  replayedMessage,
  saveNote,
  touchesOverview,
  useLayoutDraft
} from './useLayoutDraft'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({ toast: vi.fn() }))
vi.mock('sonner', () => ({
  toast: Object.assign(h.toast, { warning: h.toast, error: h.toast, success: h.toast })
}))

type Cmd = { _method: string; _path: string; _body?: unknown }

const group = (key: string, sort: number, id: number): GroupRow => ({
  ...newGroup(key, key[0].toUpperCase() + key.slice(1), 'section', null),
  sort,
  id
})
const placed = (
  field: string,
  groupKey: string | null,
  sort: number,
  id: number
): PlacementRow => ({
  ...newPlacement(field, groupKey),
  sort,
  id
})

function baseBundle(): LayoutBundle {
  return {
    layout: { id: 7, collection: 'orders', name: 'Main', layout_type: 'grouped', tab_mode: 'tabs' },
    groups: [group('main', 0, 10), group('details', 1, 11), ungroupedGroup(2)],
    placements: [
      placed('title', 'main', 0, 100),
      placed('status', 'main', 1, 101),
      placed('notes', 'details', 0, 102),
      placed('owner', null, 0, 103),
      placed('__pipeline__', null, 3, 104)
    ],
    rev: 'r1'
  }
}

/** A stand-in for POST /collection-layouts/:id/ops: applies with the shared twin, checks rev. */
function fakeServer(
  initial = baseBundle(),
  opts: { loadError?: { status: number; body: unknown } } = {}
) {
  let current = initial
  let n = 1
  const posts: Array<{ ops: LayoutOp[]; base_rev: string; note?: string }> = []
  const gates: Array<() => Promise<void>> = []
  let failNext: { status: number; body: unknown } | null = null
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._method === 'GET' && cmd._path === '/collection-layouts/7/bundle') {
        if (opts.loadError)
          throw Object.assign(new Error('request failed'), {
            status: opts.loadError.status,
            response: opts.loadError.body
          })
        return current
      }
      if (cmd._method === 'POST' && cmd._path === '/collection-layouts/7/ops') {
        const body = cmd._body as { ops: LayoutOp[]; base_rev: string }
        posts.push(body)
        const gate = gates.shift()
        if (gate) await gate()
        if (failNext) {
          const f = failNext
          failNext = null
          throw Object.assign(new Error('request failed'), { status: f.status, response: f.body })
        }
        if (body.base_rev !== current.rev) {
          throw Object.assign(new Error('stale'), {
            status: 409,
            response: { error: 'stale', bundle: current }
          })
        }
        n += 1
        current = { ...applyLayoutOps(current, body.ops), rev: `r${n}` }
        return current
      }
      throw new Error(`unexpected ${cmd._method} ${cmd._path}`)
    })
  }
  return {
    client,
    posts,
    get current() {
      return current
    },
    /** Another admin saved: the stored layout moves on without this tab knowing. */
    otherWriter(ops: LayoutOp[]) {
      n += 1
      current = { ...applyLayoutOps(current, ops), rev: `r${n}` }
    },
    failNext(status: number, body: unknown) {
      failNext = { status, body }
    },
    /** Hold the next POST until the returned release() is called. */
    hold() {
      let release!: () => void
      const p = new Promise<void>((r) => {
        release = r
      })
      gates.push(() => p)
      return () => release()
    }
  }
}

let host: HTMLDivElement
let root: Root
let draft: LayoutDraft
let qc: QueryClient
let probeId = 7
let probeOnSaved: LayoutDraftOptions['onSaved']
// The autosave suites below run with autosave on; the manual suite turns it off.
let probeAutosave = true
let rendered: (() => void) | null = null

function Probe() {
  draft = useLayoutDraft(probeId, { onSaved: probeOnSaved, autosave: probeAutosave })
  return null
}

beforeEach(() => {
  probeId = 7
  probeOnSaved = undefined
  probeAutosave = true
  h.toast.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount(client: { request: unknown }, waitForBundle = true) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  rendered = () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        // children ride the third argument; the props cast skips the required-children check
        createElement(NivaroProvider, { client } as never, createElement(Probe))
      )
    )
  await act(async () => rendered?.())
  if (waitForBundle) await settle(() => draft.bundle !== null)
}

async function settle(until: () => boolean, rounds = 100) {
  for (let i = 0; i < rounds && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
  expect(until()).toBe(true)
}

const fieldsIn = (b: LayoutBundle | null, groupKey: string | null) =>
  (b?.placements ?? [])
    .filter((p) => p.group_key === groupKey && !p.field.startsWith('__'))
    .sort((a, b2) => a.sort - b2.sort)
    .map((p) => p.field)

/** Compare bundles by content: ids (re-minted by the server on re-insert) and rev aside. */
function content(b: LayoutBundle | null) {
  if (!b) return null
  const n = applyLayoutOps(b, [{ op: 'layout_update', patch: {} }])
  return {
    layout: n.layout,
    groups: n.groups.map(({ id: _id, ...g }) => g),
    placements: n.placements.map(({ id: _id, ...p }) => p)
  }
}

describe('useLayoutDraft', () => {
  it('applies optimistically and reconciles with server bundle', async () => {
    const server = fakeServer()
    await mount(server.client)
    expect(draft.status).toBe('idle')
    const release = server.hold()

    act(() =>
      draft.apply(
        [
          {
            op: 'move',
            from: { field: 'status', group_key: 'main' },
            to_group_key: 'main',
            index: 0
          }
        ],
        { label: 'Move Status' }
      )
    )
    // Visible before the server answers.
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['status', 'title'])
    expect(draft.status).toBe('saving')

    release()
    await settle(() => draft.status === 'saved')
    expect(draft.bundle?.rev).toBe('r2')
    expect(draft.bundle).toEqual(server.current)
    expect(server.posts[0].base_rev).toBe('r1')
    // The step label rides as the ops note, so History names the edit.
    expect(server.posts[0].note).toBe('Move Status')
  })

  it('serialises batches in order', async () => {
    const server = fakeServer()
    await mount(server.client)
    const release = server.hold()

    act(() => {
      draft.apply([{ op: 'place', field: 'due', group_key: 'details', index: 1 }], {
        label: 'Add Due'
      })
      draft.apply(
        [
          {
            op: 'move',
            from: { field: 'due', group_key: 'details' },
            to_group_key: 'main',
            index: 0
          }
        ],
        { label: 'Move Due' }
      )
    })
    // Only the first request is out; the second waits for its rev.
    await settle(() => server.posts.length === 1)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(server.posts).toHaveLength(1)
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['due', 'title', 'status'])

    release()
    await settle(() => draft.status === 'saved')
    expect(server.posts.map((p) => p.ops[0].op)).toEqual(['place', 'move'])
    expect(server.posts.map((p) => p.base_rev)).toEqual(['r1', 'r2'])
    expect(fieldsIn(server.current, 'main')).toEqual(['due', 'title', 'status'])
    expect(draft.bundle).toEqual(server.current)
  })

  it('rolls back a failed batch and surfaces the message', async () => {
    const server = fakeServer()
    await mount(server.client)
    const before = draft.bundle
    server.failNext(400, { error: 'Slug "main" is already used by another layout', op_index: 0 })

    act(() => draft.apply([{ op: 'layout_update', patch: { slug: 'main' } }], { label: 'Rename' }))
    expect(draft.bundle?.layout.slug).toBe('main')

    await settle(() => draft.status === 'error')
    expect(draft.error).toBe('Slug "main" is already used by another layout')
    expect(draft.bundle).toEqual(before)
    // The failed batch is not an undo step.
    expect(draft.canUndo).toBe(false)
  })

  it('replays a batch refused as stale on top of the other save (#2652)', async () => {
    const server = fakeServer()
    await mount(server.client)
    server.otherWriter([{ op: 'remove', at: { field: 'notes', group_key: 'details' } }])

    act(() =>
      draft.apply(
        [
          {
            op: 'update_placement',
            at: { field: 'title', group_key: 'main' },
            patch: { col_span: 6 }
          }
        ],
        { label: 'Width' }
      )
    )
    await settle(() => draft.status === 'saved')
    expect(server.posts.map((p) => p.base_rev)).toEqual(['r1', 'r2'])
    expect(fieldsIn(server.current, 'details')).toEqual([])
    expect(server.current.placements.find((p) => p.field === 'title')?.col_span).toBe(6)
    expect(content(draft.bundle)).toEqual(content(server.current))
    expect(h.toast).toHaveBeenCalledWith(replayedMessage(1))
    expect(draft.dropped).toEqual([])
    expect(draft.undoLabel).toBe('Width')
  })

  it('drops a stale batch that no longer fits and lists it', async () => {
    const server = fakeServer()
    await mount(server.client)
    server.otherWriter([{ op: 'remove', at: { field: 'notes', group_key: 'details' } }])
    act(() =>
      draft.apply(
        [
          {
            op: 'update_placement',
            at: { field: 'notes', group_key: 'details' },
            patch: { col_span: 6 }
          }
        ],
        { label: 'Width of Notes' }
      )
    )
    await settle(() => draft.dropped.length === 1)
    expect(draft.dropped).toEqual(['Width of Notes'])
    expect(draft.bundle).toEqual(server.current)
    expect(server.posts).toHaveLength(1)
    expect(draft.canUndo).toBe(false)
    expect(h.toast).toHaveBeenCalledWith(partlyRebasedMessage(0, 1))
    act(() => draft.clearDropped())
    expect(draft.dropped).toEqual([])
  })

  it('reloads on a 409 without the stored layout', async () => {
    const server = fakeServer()
    await mount(server.client)
    server.failNext(409, { error: 'stale' })
    act(() =>
      draft.apply(
        [
          {
            op: 'update_placement',
            at: { field: 'title', group_key: 'main' },
            patch: { col_span: 6 }
          }
        ],
        { label: 'Width' }
      )
    )
    await settle(() => draft.status === 'conflict')
    expect(h.toast).toHaveBeenCalledWith('Someone else changed this layout — reloaded')
    expect(draft.canUndo).toBe(false)
  })

  it('undo then redo restores the same bundle', async () => {
    const server = fakeServer()
    await mount(server.client)
    const original = content(draft.bundle)

    act(() =>
      draft.apply(
        [
          { op: 'remove', at: { field: 'status', group_key: 'main' } },
          { op: 'group_remove', key: 'details', placements: 'ungroup' },
          { op: 'layout_update', patch: { tab_mode: 'steps' } }
        ],
        { label: 'Tidy up' }
      )
    )
    await settle(() => draft.status === 'saved')
    const edited = content(draft.bundle)
    expect(draft.canUndo).toBe(true)
    expect(draft.undoLabel).toBe('Tidy up')

    act(() => draft.undo())
    expect(content(draft.bundle)).toEqual(original)
    await settle(() => draft.status === 'saved' && server.posts.length === 2)
    expect(content(server.current)).toEqual(original)
    expect(server.posts.map((p) => p.note)).toEqual(['Tidy up', 'Undo Tidy up'])
    expect(draft.canRedo).toBe(true)

    act(() => draft.redo())
    expect(content(draft.bundle)).toEqual(edited)
    await settle(() => draft.status === 'saved' && server.posts.length === 3)
    expect(content(server.current)).toEqual(edited)
    expect(draft.canRedo).toBe(false)
    expect(draft.canUndo).toBe(true)
  })

  it('a batch applied with undoable: false is saved but pushes no undo step', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() =>
      draft.apply([{ op: 'remove', at: { field: 'status', group_key: 'main' } }], {
        label: 'Remove Status'
      })
    )
    await settle(() => draft.status === 'saved')
    act(() => draft.undo())
    await settle(() => draft.status === 'saved' && server.posts.length === 2)
    expect(draft.canRedo).toBe(true)

    act(() =>
      draft.apply([{ op: 'layout_update', patch: { tab_mode: 'steps' } }], {
        label: 'Make default',
        undoable: false
      })
    )
    expect(draft.bundle?.layout.tab_mode).toBe('steps')
    await settle(() => draft.status === 'saved' && server.posts.length === 3)
    expect(server.current.layout.tab_mode).toBe('steps')
    expect(server.posts[2].note).toBe('Make default')
    // Nothing to undo (the earlier step was undone) and the redo stack is untouched.
    expect(draft.canUndo).toBe(false)
    expect(draft.canRedo).toBe(true)
    expect(draft.redoLabel).toBe('Remove Status')
  })

  it('debounces text edits into one op', async () => {
    const server = fakeServer()
    await mount(server.client)
    const at = { field: 'title', group_key: 'main' }

    for (const value of ['P', 'PO', 'PO n', 'PO number']) {
      act(() =>
        draft.apply([{ op: 'update_placement', at, patch: { label_override: value } }], {
          label: 'Rename field',
          text: true
        })
      )
      // Typing pace: well under the pause that sends.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100))
      })
    }
    // Shown as typed, nothing sent yet.
    expect(draft.bundle?.placements.find((p) => p.field === 'title')?.label_override).toBe(
      'PO number'
    )
    expect(server.posts).toHaveLength(0)

    await settle(() => draft.status === 'saved', 150)
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0].ops).toEqual([
      { op: 'update_placement', at, patch: { label_override: 'PO number' } }
    ])

    // One undo step for the whole burst, back to the value before the first keystroke.
    act(() => draft.undo())
    expect(draft.bundle?.placements.find((p) => p.field === 'title')?.label_override).toBe(null)
    expect(draft.canUndo).toBe(false)
  })

  it('sends a pending text edit before a later structural op', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() => {
      draft.apply([{ op: 'group_update', key: 'main', patch: { label: 'General' } }], {
        label: 'Rename section',
        text: true
      })
      draft.apply([{ op: 'group_move', key: 'details', parent_key: null, index: 0 }], {
        label: 'Move section'
      })
    })
    await settle(() => draft.status === 'saved' && server.posts.length === 2)
    expect(server.posts.map((p) => p.ops[0].op)).toEqual(['group_update', 'group_move'])
    expect(server.current.groups.find((g) => g.key === 'main')?.label).toBe('General')
  })
})

describe('useLayoutDraft — failures, other writers, flushing', () => {
  it('surfaces a bundle that fails to load', async () => {
    const server = fakeServer(baseBundle(), {
      loadError: { status: 404, body: { error: 'Layout not found' } }
    })
    await mount(server.client, false)
    await settle(() => draft.status === 'error')
    expect(draft.bundle).toBe(null)
    expect(draft.error).toBe('Layout not found')
    expect(draft.isLoading).toBe(false)
  })

  it("drops the undo history when another admin's save is fetched", async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() =>
      draft.apply([{ op: 'remove', at: { field: 'status', group_key: 'main' } }], {
        label: 'Remove Status'
      })
    )
    await settle(() => draft.status === 'saved')
    expect(draft.canUndo).toBe(true)

    server.otherWriter([
      { op: 'move', from: { field: 'notes', group_key: 'details' }, to_group_key: 'main', index: 0 }
    ])
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['layout-editor', 'bundle', 7] })
    })
    await settle(() => draft.bundle?.rev === server.current.rev)
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['notes', 'title'])
    expect(draft.canUndo).toBe(false)
    expect(draft.canRedo).toBe(false)
  })

  it('flush sends typed text without waiting for the pause', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() =>
      draft.apply([{ op: 'group_update', key: 'main', patch: { label: 'General' } }], {
        label: 'Rename section',
        text: true
      })
    )
    act(() => draft.flush())
    await settle(() => server.posts.length === 1, 20)
    expect(server.posts[0].ops).toEqual([
      { op: 'group_update', key: 'main', patch: { label: 'General' } }
    ])
    expect(server.posts[0].note).toBe('Rename section')
  })

  it('unmount flushes pending text', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() =>
      draft.apply([{ op: 'layout_update', patch: { name: 'Main form' } }], {
        label: 'Rename form',
        text: true
      })
    )
    act(() => root.render(null))
    await settle(() => server.posts.length === 1, 20)
    expect(server.current.layout.name).toBe('Main form')
  })

  it('rolls back the failed batch and re-applies the later one', async () => {
    const server = fakeServer()
    await mount(server.client)
    const release = server.hold()
    server.failNext(400, { error: 'Field "due" does not exist', op_index: 0 })
    act(() => {
      draft.apply([{ op: 'place', field: 'due', group_key: 'details', index: 1 }], {
        label: 'Add Due'
      })
      draft.apply(
        [
          {
            op: 'update_placement',
            at: { field: 'title', group_key: 'main' },
            patch: { col_span: 6 }
          }
        ],
        { label: 'Width' }
      )
    })
    release()
    await settle(() => server.posts.length === 2 && draft.status !== 'saving')
    expect(draft.status).toBe('error')
    expect(draft.error).toBe('Field "due" does not exist')
    expect(fieldsIn(draft.bundle, 'details')).toEqual(['notes'])
    expect(draft.bundle?.placements.find((p) => p.field === 'title')?.col_span).toBe(6)
    expect(draft.bundle).toEqual(server.current)
    expect(draft.undoLabel).toBe('Width')
  })

  it("keeps the server's message when a later batch no longer applies", async () => {
    const server = fakeServer()
    await mount(server.client)
    const before = draft.bundle
    const release = server.hold()
    server.failNext(400, { error: 'Field "due" does not exist', op_index: 0 })
    act(() => {
      draft.apply([{ op: 'place', field: 'due', group_key: 'details', index: 1 }], {
        label: 'Add Due'
      })
      draft.apply(
        [
          {
            op: 'move',
            from: { field: 'due', group_key: 'details' },
            to_group_key: 'main',
            index: 0
          }
        ],
        { label: 'Move Due' }
      )
    })
    release()
    await settle(() => draft.status === 'error')
    expect(draft.error).toBe('Field "due" does not exist')
    expect(draft.bundle).toEqual(before)
    expect(server.posts).toHaveLength(1)
    expect(draft.canUndo).toBe(false)
  })
})

describe('useLayoutDraft — leaving, refreshing, reopening', () => {
  it('whenIdle sends typed text and resolves once the save has landed', async () => {
    const server = fakeServer()
    await mount(server.client)
    const release = server.hold()
    act(() =>
      draft.apply([{ op: 'layout_update', patch: { name: 'Main form' } }], {
        label: 'Rename form',
        text: true
      })
    )
    let idle = false
    let done: Promise<void> = Promise.resolve()
    act(() => {
      done = draft.whenIdle().then(() => {
        idle = true
      })
    })
    await settle(() => server.posts.length === 1, 20)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(idle).toBe(false)
    release()
    await act(async () => {
      await done
    })
    expect(idle).toBe(true)
    expect(server.current.layout.name).toBe('Main form')
  })

  it('whenIdle resolves at once with nothing pending, and after a failure too', async () => {
    const server = fakeServer()
    await mount(server.client)
    await act(async () => {
      await draft.whenIdle()
    })
    server.failNext(400, { error: 'nope' })
    act(() => draft.apply([{ op: 'layout_update', patch: { slug: 'x' } }], { label: 'Slug' }))
    await act(async () => {
      await draft.whenIdle()
    })
    expect(draft.status).toBe('error')
  })

  it('onSaved gets each confirmed bundle with the batch that made it', async () => {
    const server = fakeServer()
    const seen: Array<{ rev: string; ops: LayoutOp[] | null }> = []
    probeOnSaved = (bundle, ops) => seen.push({ rev: bundle.rev, ops })
    await mount(server.client)
    const op: LayoutOp = { op: 'remove', at: { field: 'status', group_key: 'main' } }
    act(() => draft.apply([op], { label: 'Remove Status' }))
    await settle(() => draft.status === 'saved')
    expect(seen).toEqual([{ rev: 'r2', ops: [op] }])
  })

  it('reopening a layout whose save is still in flight reuses that draft (no false conflict)', async () => {
    const server = fakeServer()
    await mount(server.client)
    const release = server.hold()
    act(() =>
      draft.apply([{ op: 'remove', at: { field: 'status', group_key: 'main' } }], {
        label: 'Remove Status'
      })
    )
    await settle(() => server.posts.length === 1, 20)
    // A → B → A while A's first save is still out.
    probeId = 8
    await act(async () => rendered?.())
    probeId = 7
    await act(async () => rendered?.())
    act(() =>
      draft.apply([{ op: 'remove', at: { field: 'notes', group_key: 'details' } }], {
        label: 'Remove Notes'
      })
    )
    release()
    await settle(() => server.posts.length === 2 && draft.status === 'saved')
    expect(server.posts.map((p) => p.base_rev)).toEqual(['r1', 'r2'])
    expect(h.toast).not.toHaveBeenCalled()
    expect(fieldsIn(server.current, 'main')).toEqual(['title'])
    expect(fieldsIn(server.current, 'details')).toEqual([])
  })
})

describe('useLayoutDraft — manual save (autosave off, the default)', () => {
  beforeEach(() => {
    probeAutosave = false
  })
  const moveStatusFirst: LayoutOp = {
    op: 'move',
    from: { field: 'status', group_key: 'main' },
    to_group_key: 'main',
    index: 0
  }
  const removeNotes: LayoutOp = { op: 'remove', at: { field: 'notes', group_key: 'details' } }
  const wait = (ms: number) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms))
    })
  const labelOf = (field: string) =>
    draft.bundle?.placements.find((p) => p.field === field)?.label_override

  it('holds changes locally until Save, then sends them as one batch', async () => {
    const server = fakeServer()
    await mount(server.client)
    expect(draft.autosave).toBe(false)
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    act(() => draft.apply([removeNotes], { label: 'Remove Notes' }))
    await wait(30)
    expect(server.posts).toHaveLength(0)
    expect(draft.dirty).toBe(true)
    expect(draft.unsavedCount).toBe(2)
    expect(draft.unsavedOps()).toEqual([moveStatusFirst, removeNotes])
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['status', 'title'])
    expect(draft.status).toBe('idle')

    await act(async () => {
      await draft.save()
    })
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0]).toEqual({
      ops: [moveStatusFirst, removeNotes],
      base_rev: 'r1',
      note: '2 changes: Move Status, Remove Notes'
    })
    expect(draft.dirty).toBe(false)
    expect(draft.unsavedOps()).toEqual([])
    expect(draft.status).toBe('saved')
    expect(draft.bundle).toEqual(server.current)
    // Saved steps still undo, as an unsaved change of their own.
    expect(draft.undoLabel).toBe('Remove Notes')
  })

  it('a typing burst is one unsaved change until blur; nothing waits for a pause', async () => {
    const server = fakeServer()
    await mount(server.client)
    const at = { field: 'title', group_key: 'main' }
    for (const value of ['P', 'PO', 'PO number'])
      act(() =>
        draft.apply([{ op: 'update_placement', at, patch: { label_override: value } }], {
          label: 'Rename field',
          text: true
        })
      )
    expect(draft.unsavedCount).toBe(1)
    expect(labelOf('title')).toBe('PO number')
    act(() => draft.flush())
    act(() =>
      draft.apply([{ op: 'update_placement', at, patch: { label_override: 'PO no.' } }], {
        label: 'Rename field',
        text: true
      })
    )
    expect(draft.unsavedCount).toBe(2)
    await wait(700)
    expect(server.posts).toHaveLength(0)
    // Undo pops the newest burst, then the first: back to before the first keystroke.
    act(() => draft.undo())
    expect(labelOf('title')).toBe('PO number')
    act(() => draft.undo())
    expect(labelOf('title')).toBe(null)
    expect(draft.dirty).toBe(false)
    expect(server.posts).toHaveLength(0)
  })

  it('unsaved steps undo and redo locally; a saved step undoes as an unsaved change', async () => {
    const server = fakeServer()
    await mount(server.client)
    const original = content(draft.bundle)
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    act(() => draft.undo())
    expect(content(draft.bundle)).toEqual(original)
    expect(draft.dirty).toBe(false)
    expect(draft.canRedo).toBe(true)
    act(() => draft.redo())
    expect(draft.unsavedCount).toBe(1)
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['status', 'title'])
    await act(async () => {
      await draft.save()
    })
    expect(server.posts).toHaveLength(1)

    act(() => draft.undo())
    expect(content(draft.bundle)).toEqual(original)
    expect(draft.unsavedCount).toBe(1)
    expect(server.posts).toHaveLength(1)
    await act(async () => {
      await draft.save()
    })
    expect(server.posts[1].note).toBe('Undo Move Status')
    expect(content(server.current)).toEqual(original)
    expect(draft.canRedo).toBe(true)
  })

  it('session history lists every step, marks saved vs unsaved, and jumps both ways (#2618)', async () => {
    const server = fakeServer()
    await mount(server.client)
    const original = content(draft.bundle)
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    await act(async () => {
      await draft.save()
    })
    act(() => draft.apply([removeNotes], { label: 'Remove Notes' }))
    expect(draft.session).toEqual({
      done: [
        { label: 'Move Status', state: 'saved' },
        { label: 'Remove Notes', state: 'unsaved' }
      ],
      undone: []
    })

    // Back to the start: two undos (the unsaved one pops, the saved one becomes unsaved).
    act(() => draft.jump(-2))
    expect(content(draft.bundle)).toEqual(original)
    expect(draft.session.done).toEqual([])
    expect(draft.session.undone.map((s) => s.label)).toEqual(['Move Status', 'Remove Notes'])
    expect(server.posts).toHaveLength(1)

    // Forward again past both; a jump beyond the end stops at the end.
    act(() => draft.jump(5))
    expect(draft.session.done.map((s) => s.label)).toEqual(['Move Status', 'Remove Notes'])
    expect(draft.session.undone).toEqual([])
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['status', 'title'])
    expect(fieldsIn(draft.bundle, 'details')).toEqual([])
  })

  it('a stale Save rebases the unsaved steps onto the newer layout and keeps them', async () => {
    const server = fakeServer()
    await mount(server.client)
    server.otherWriter([removeNotes])
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    await act(async () => {
      await draft.save()
    })
    expect(h.toast).toHaveBeenCalledWith(rebasedMessage(1))
    expect(draft.status).not.toBe('conflict')
    expect(draft.dirty).toBe(true)
    expect(fieldsIn(draft.bundle, 'details')).toEqual([])
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['status', 'title'])
    // Undo still pops the kept step.
    expect(draft.undoLabel).toBe('Move Status')

    await act(async () => {
      await draft.save()
    })
    expect(server.posts.map((p) => p.base_rev)).toEqual(['r1', 'r2'])
    expect(draft.dirty).toBe(false)
    expect(fieldsIn(server.current, 'main')).toEqual(['status', 'title'])
    expect(fieldsIn(server.current, 'details')).toEqual([])
  })

  it('a stale Save keeps the steps that still fit and lists the ones that do not (#2652)', async () => {
    const server = fakeServer()
    await mount(server.client)
    server.otherWriter([removeNotes])
    act(() =>
      draft.apply(
        [
          {
            op: 'move',
            from: { field: 'notes', group_key: 'details' },
            to_group_key: 'main',
            index: 0
          }
        ],
        { label: 'Move Notes' }
      )
    )
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    await act(async () => {
      await draft.save()
    })
    expect(draft.status).toBe('idle')
    expect(draft.dropped).toEqual(['Move Notes'])
    expect(draft.unsavedSteps.map((s) => s.label)).toEqual(['Move Status'])
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['status', 'title'])
    expect(fieldsIn(draft.bundle, 'details')).toEqual([])
    expect(draft.undoLabel).toBe('Move Status')
    expect(h.toast).toHaveBeenCalledWith(partlyRebasedMessage(1, 1))

    act(() => draft.discard())
    expect(draft.dirty).toBe(false)
    expect(draft.dropped).toEqual([])
    expect(content(draft.bundle)).toEqual(content(server.current))
    expect(draft.canUndo).toBe(false)
  })

  it('keeps the undo of a saved setting nobody else touched across a rebase', async () => {
    const server = fakeServer()
    await mount(server.client)
    const width: LayoutOp = {
      op: 'update_placement',
      at: { field: 'title', group_key: 'main' },
      patch: { col_span: 6 }
    }
    act(() => draft.apply([width], { label: 'Width' }))
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    await act(async () => {
      await draft.save()
    })
    server.otherWriter([removeNotes])
    act(() =>
      draft.apply([{ op: 'layout_update', patch: { tab_mode: 'steps' } }], { label: 'Steps' })
    )
    await act(async () => {
      await draft.save()
    })
    expect(draft.dirty).toBe(true)
    // Steps (kept, unsaved) → Width (saved, its value still stands); Move Status (index-based) went.
    act(() => draft.undo())
    expect(draft.undoLabel).toBe('Width')
    act(() => draft.undo())
    expect(draft.bundle?.placements.find((p) => p.field === 'title')?.col_span).toBe(null)
    expect(draft.canUndo).toBe(false)
  })

  it('save(meta) sends the change note with the batch (#2654)', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    await act(async () => {
      await draft.save({ reason: 'Status first for triage', ticket: 'OPS-12' })
    })
    expect(server.posts[0]).toMatchObject({
      note: 'Move Status',
      reason: 'Status first for triage',
      ticket: 'OPS-12'
    })
  })

  it('unsavedSteps and baseRev describe the draft; restore re-applies steps (#2653)', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    expect(draft.baseRev).toBe('r1')
    const steps = draft.unsavedSteps
    expect(steps).toEqual([{ label: 'Move Status', ops: [moveStatusFirst] }])
    act(() => draft.discard())
    let n = 0
    act(() => {
      n = draft.restore([
        ...steps,
        {
          label: 'Width of Gone',
          ops: [{ op: 'remove', at: { field: 'gone', group_key: 'main' } }]
        }
      ])
    })
    expect(n).toBe(1)
    expect(draft.unsavedSteps.map((s) => s.label)).toEqual(['Move Status'])
    expect(draft.dropped).toEqual(['Width of Gone'])
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['status', 'title'])
    expect(server.posts).toHaveLength(0)
  })

  it('a refused Save keeps every change unsaved and says why', async () => {
    const server = fakeServer()
    await mount(server.client)
    server.failNext(400, { error: 'Field "due" does not exist', op_index: 1 })
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    await act(async () => {
      await draft.save()
    })
    expect(draft.status).toBe('error')
    expect(draft.error).toBe('Field "due" does not exist')
    expect(draft.unsavedOps()).toEqual([moveStatusFirst])
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['status', 'title'])
    expect(draft.undoLabel).toBe('Move Status')
  })

  it('turning autosave on saves what is unsaved; then every change sends at once', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    act(() => draft.setAutosave(true))
    await settle(() => draft.status === 'saved')
    expect(draft.autosave).toBe(true)
    expect(server.posts).toHaveLength(1)
    expect(draft.dirty).toBe(false)
    act(() => draft.apply([removeNotes], { label: 'Remove Notes' }))
    await settle(() => draft.status === 'saved' && server.posts.length === 2)
    act(() => draft.setAutosave(false))
    act(() =>
      draft.apply([{ op: 'layout_update', patch: { tab_mode: 'steps' } }], { label: 'Steps' })
    )
    await wait(30)
    expect(server.posts).toHaveLength(2)
    expect(draft.unsavedCount).toBe(1)
  })

  it('a refetch never replaces unsaved changes', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    server.otherWriter([removeNotes])
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ['layout-editor', 'bundle', 7] })
    })
    await wait(30)
    expect(draft.bundle?.rev).toBe('r1')
    expect(fieldsIn(draft.bundle, 'details')).toEqual(['notes'])
    expect(draft.dirty).toBe(true)
  })

  it('discard drops unsaved steps and gives a saved step its undo back', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    await act(async () => {
      await draft.save()
    })
    const saved = content(draft.bundle)
    act(() => draft.undo())
    act(() => draft.apply([removeNotes], { label: 'Remove Notes' }))
    expect(draft.unsavedCount).toBe(2)
    act(() => draft.discard())
    expect(draft.dirty).toBe(false)
    expect(content(draft.bundle)).toEqual(saved)
    expect(draft.undoLabel).toBe('Move Status')
    expect(server.posts).toHaveLength(1)
  })

  it('reopening a layout closed with unsaved changes finds them again', async () => {
    const server = fakeServer()
    await mount(server.client)
    act(() => draft.apply([moveStatusFirst], { label: 'Move Status' }))
    probeId = 8
    await act(async () => rendered?.())
    probeId = 7
    await act(async () => rendered?.())
    expect(draft.unsavedCount).toBe(1)
    expect(fieldsIn(draft.bundle, 'main')).toEqual(['status', 'title'])
  })
})

describe('saveNote', () => {
  it('names one step, counts several and stays under the note column', () => {
    expect(saveNote(['Move Status'])).toBe('Move Status')
    expect(saveNote(['A', 'B'])).toBe('2 changes: A, B')
    const long = saveNote(Array.from({ length: 80 }, (_, i) => `Change number ${i}`))
    expect(long.length).toBeLessThanOrEqual(250)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('touchesOverview', () => {
  it('only layout settings the overview reads count; unknown batches count', () => {
    expect(touchesOverview(null)).toBe(true)
    expect(touchesOverview([{ op: 'layout_update', patch: { name: 'X' } }])).toBe(true)
    expect(touchesOverview([{ op: 'layout_update', patch: { record_conditions: [] } }])).toBe(true)
    expect(touchesOverview([{ op: 'layout_update', patch: { ai_enabled: true } }])).toBe(false)
    expect(
      touchesOverview([
        { op: 'remove', at: { field: 'a', group_key: null } },
        { op: 'group_update', key: 'main', patch: { label: 'General' } }
      ])
    ).toBe(false)
  })
})

describe('inverseOps', () => {
  // Every golden success case of the ops twin: apply, then apply the inverse → the start again.
  const { cases } = JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../lib/layout-ops.fixtures.json'),
      'utf8'
    )
  ) as { cases: Array<{ name: string; before: LayoutBundle; ops: LayoutOp[]; error?: unknown }> }

  for (const c of cases.filter((x) => !x.error)) {
    it(`undoes: ${c.name}`, () => {
      const before = { ...c.before, rev: 'r' }
      const inverse = inverseOps(before, c.ops)
      const after = applyLayoutOps(before, c.ops)
      expect(content(applyLayoutOps(after, inverse))).toEqual(content(before))
    })
  }

  it('undoes removing a group whose fields were already ungrouped twins', () => {
    const b = baseBundle()
    b.placements.push(placed('notes', null, 1, 200))
    b.placements.push(placed('status', 'details', 1, 201), {
      ...placed('__tasks__', 'details', 2, 202),
      label_override: 'Work'
    })
    const ops: LayoutOp[] = [{ op: 'group_remove', key: 'details', placements: 'ungroup' }]
    const after = applyLayoutOps(b, ops)
    expect(content(applyLayoutOps(after, inverseOps(b, ops)))).toEqual(content(b))
  })
})
