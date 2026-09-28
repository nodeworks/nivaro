import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async () => ({
    id: 0,
    progress: vi.fn(),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {})
  }))
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/job-cancel.js', () => ({
  requestCancel: vi.fn(),
  isCancelled: vi.fn(() => false),
  clearCancel: vi.fn()
}))

import {
  clearOpsTasks,
  getOpsTaskRun,
  listOpsTasks,
  registerOpsTask,
  startOpsTask
} from '../../../services/ops-tasks.js'

const settle = () => new Promise((r) => setTimeout(r, 20))

describe('ops tasks (#827)', () => {
  beforeEach(() => clearOpsTasks())

  it('refuses a bad key and a task without execute', () => {
    expect(() =>
      registerOpsTask({
        key: 'no space',
        label: 'x',
        description: '',
        execute: async () => ({ summary: '' })
      })
    ).toThrow(/key/)
    expect(() => registerOpsTask({ key: 'a:b', label: 'x', description: '' } as never)).toThrow(
      /execute/
    )
  })

  it('dry-runs by default, records output and outcome, and refuses a second run while one is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    registerOpsTask(
      {
        key: 'ext:repair',
        label: 'Repair',
        description: 'd',
        dryRun: async (rc) => {
          rc.log('would fix 3 rows')
          rc.progress(3, 3)
          await gate
          return { summary: '3 rows would move', counts: { rows: 3 } }
        },
        execute: async () => ({ summary: 'done' })
      },
      'ext'
    )
    expect(listOpsTasks().map((t) => `${t.owner} ${t.key}`)).toEqual(['ext ext:repair'])
    const run = await startOpsTask('ext:repair', { userId: 'u1' })
    expect(run.mode).toBe('dry')
    await settle()
    expect(getOpsTaskRun(run.id)?.output).toEqual(['would fix 3 rows'])
    expect(getOpsTaskRun(run.id)?.progress).toEqual({ done: 3, total: 3 })
    await expect(startOpsTask('ext:repair', {})).rejects.toMatchObject({ statusCode: 409 })
    release()
    await settle()
    expect(getOpsTaskRun(run.id)).toMatchObject({
      status: 'completed',
      outcome: { summary: '3 rows would move' }
    })
    // free again
    const again = await startOpsTask('ext:repair', { execute: true })
    await settle()
    expect(getOpsTaskRun(again.id)).toMatchObject({
      mode: 'execute',
      status: 'completed',
      outcome: { summary: 'done' }
    })
  })

  it('a task without a dry run refuses one, an unavailable task refuses with its reason and CLI', async () => {
    registerOpsTask(
      { key: 'ext:only-real', label: 'x', description: '', execute: async () => ({ summary: '' }) },
      'ext'
    )
    await expect(startOpsTask('ext:only-real', {})).rejects.toMatchObject({ statusCode: 400 })
    registerOpsTask(
      {
        key: 'ext:elsewhere',
        label: 'x',
        description: '',
        cli: 'pnpm fix',
        available: () => ({ ok: false, reason: 'no sources' }),
        execute: async () => ({ summary: '' })
      },
      'ext'
    )
    await expect(startOpsTask('ext:elsewhere', { execute: true })).rejects.toThrow(
      /no sources — CLI: pnpm fix/
    )
  })

  it('a throwing task lands as error with the message', async () => {
    registerOpsTask(
      {
        key: 'ext:boom',
        label: 'x',
        description: '',
        execute: async () => {
          throw new Error('disk full')
        }
      },
      'ext'
    )
    const run = await startOpsTask('ext:boom', { execute: true })
    await settle()
    expect(getOpsTaskRun(run.id)).toMatchObject({ status: 'error', error: 'disk full' })
  })
})
