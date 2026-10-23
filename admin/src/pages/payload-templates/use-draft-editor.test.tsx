import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftBody, TemplateDetail } from './api'

// The autosave queue behind the editor (saveNow / discardPending), against a
// save whose every call the test resolves or rejects by hand.

type Deferred = {
  args: { draft: DraftBody; base_rev: number }
  resolve: (v: { rev: number }) => void
  reject: (e: unknown) => void
}
const calls = vi.hoisted(() => ({ list: [] as unknown[] }))

vi.mock('./api', async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  useSaveDraft: () => ({
    mutateAsync: (args: Deferred['args']) =>
      new Promise((resolve, reject) => {
        calls.list.push({ args, resolve, reject })
      })
  })
}))

import { useDraftEditor } from './PayloadTemplateEditor'

const list = () => calls.list as Deferred[]

const detail = {
  id: 1,
  key: 'k',
  label: 'K',
  collection: 'inventory_request',
  draft_mode: 'map',
  draft_body: '{"v":1,"fields":[]}',
  draft_rev: 3,
  published_mode: 'map',
  published_body: '{"v":1,"fields":[]}',
  published_version: 2,
  locked_keys: [],
  used_by: [],
  newer_default: false
} as unknown as TemplateDetail

const d = (n: number): DraftBody => ({
  mode: 'map',
  body: { v: 1, fields: [{ id: `f${n}`, key: `k${n}`, type: 'text', include: 'always' }] }
})

/** Let queued promise callbacks run. */
const flushMicro = () => act(async () => {})

function setup() {
  return renderHook(() => useDraftEditor('k', detail))
}

beforeEach(() => {
  calls.list.length = 0
})

describe('useDraftEditor autosave queue', () => {
  it('saveNow during an in-flight save with a queued edit resolves true at the final rev', async () => {
    const { result } = setup()
    act(() => result.current.change(d(1)))
    let first!: Promise<boolean>
    act(() => {
      first = result.current.saveNow()
    })
    await flushMicro()
    expect(list()).toHaveLength(1)
    expect(list()[0].args.base_rev).toBe(3)

    act(() => result.current.change(d(2)))
    let done!: Promise<boolean>
    act(() => {
      done = result.current.saveNow()
    })
    await act(async () => list()[0].resolve({ rev: 4 }))
    await flushMicro()
    expect(list()).toHaveLength(2)
    expect(list()[1].args).toMatchObject({ draft: d(2), base_rev: 4 })
    await act(async () => list()[1].resolve({ rev: 5 }))

    await expect(done).resolves.toBe(true)
    await expect(first).resolves.toBe(true)
    expect(result.current.getRev()).toBe(5)
    expect(result.current.rev).toBe(5)
  })

  it('saveNow after the server refuses the draft (400) resolves false with its errors', async () => {
    const { result } = setup()
    act(() => result.current.change(d(1)))
    let p!: Promise<boolean>
    act(() => {
      p = result.current.saveNow()
    })
    await flushMicro()
    await act(async () =>
      list()[0].reject({
        response: { status: 400, data: { error: 'invalid', errors: ['fields[0].key is empty'] } }
      })
    )
    await expect(p).resolves.toBe(false)
    expect(result.current.state).toMatchObject({
      kind: 'error',
      errors: ['fields[0].key is empty']
    })
  })

  it('saveNow while a 409 blocks saving resolves false and sends nothing more', async () => {
    const { result } = setup()
    act(() => result.current.change(d(1)))
    let p!: Promise<boolean>
    act(() => {
      p = result.current.saveNow()
    })
    await flushMicro()
    await act(async () =>
      list()[0].reject({
        response: { status: 409, data: { error: 'stale', current: { ...detail, draft_rev: 9 } } }
      })
    )
    await expect(p).resolves.toBe(false)
    expect(result.current.state.kind).toBe('conflict')

    act(() => result.current.change(d(2)))
    let again!: Promise<boolean>
    act(() => {
      again = result.current.saveNow()
    })
    await expect(again).resolves.toBe(false)
    expect(list()).toHaveLength(1)
  })

  it('discardPending during an in-flight save leaves nothing queued', async () => {
    const { result } = setup()
    act(() => result.current.change(d(1)))
    act(() => {
      void result.current.saveNow()
    })
    await flushMicro()
    act(() => result.current.change(d(2)))
    let dp!: Promise<void>
    act(() => {
      dp = result.current.discardPending()
    })
    await act(async () => list()[0].resolve({ rev: 4 }))
    await act(async () => dp)
    await flushMicro()
    expect(list()).toHaveLength(1)

    let p!: Promise<boolean>
    act(() => {
      p = result.current.saveNow()
    })
    await expect(p).resolves.toBe(true)
    expect(list()).toHaveLength(1)
    expect(result.current.getRev()).toBe(4)
  })
})
