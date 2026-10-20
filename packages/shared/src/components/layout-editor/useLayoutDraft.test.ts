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
import { inverseOps, type LayoutDraft, useLayoutDraft } from './useLayoutDraft'

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

function Probe() {
  draft = useLayoutDraft(7)
  return null
}

beforeEach(() => {
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
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        // children ride the third argument; the props cast skips the required-children check
        createElement(NivaroProvider, { client } as never, createElement(Probe))
      )
    )
  })
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

  it('reloads on 409', async () => {
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
    await settle(() => draft.status === 'conflict')
    expect(draft.bundle).toEqual(server.current)
    expect(fieldsIn(draft.bundle, 'details')).toEqual([])
    expect(draft.bundle?.placements.find((p) => p.field === 'title')?.col_span).toBe(null)
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
