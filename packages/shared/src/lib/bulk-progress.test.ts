// @vitest-environment jsdom

// useBulkRowState reads module state; exercise it through a tiny harness.
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  __applyBulkRows,
  __resetBulkProgress,
  endBulkProgress,
  newBulkProgressId,
  startBulkProgress,
  useBulkRowState
} from './bulk-progress'

const stateOf = (id: string) => {
  let out: unknown = null
  const Probe = () => {
    out = useBulkRowState(id)
    return null
  }
  renderToString(createElement(Probe))
  return out
}

describe('bulk row progress (client)', () => {
  beforeEach(() => __resetBulkProgress())

  it('makes ids the server accepts', () => {
    expect(newBulkProgressId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  })

  it('marks the selection waiting, then follows the server rows', () => {
    const id = newBulkProgressId()
    startBulkProgress(id, [1, 2, 3])
    expect(stateOf('1')).toEqual({ status: 'queued' })
    __applyBulkRows({ progress: id, rows: [{ id: '1', status: 'done' }], running: '2' })
    expect(stateOf('1')).toEqual({ status: 'done', reason: undefined })
    expect(stateOf('2')).toEqual({ status: 'running' })
    __applyBulkRows({
      progress: id,
      rows: [{ id: '2', status: 'failed', reason: 'Locked' }],
      running: null
    })
    expect(stateOf('2')).toEqual({ status: 'failed', reason: 'Locked' })
    expect(stateOf('99')).toBeNull()
  })

  it('ignores events of another run and settles leftovers when the request ends', () => {
    const id = newBulkProgressId()
    startBulkProgress(id, [1, 2])
    __applyBulkRows({ progress: 'someone-elses-run', rows: [{ id: '1', status: 'failed' }] })
    expect(stateOf('1')).toEqual({ status: 'queued' })
    endBulkProgress(id, 10_000)
    expect(stateOf('2')).toEqual({ status: 'done' })
  })
})
