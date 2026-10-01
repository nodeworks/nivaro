import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'staging' }))

import {
  DEV_LOG_TTL_MS,
  devInstanceKeys,
  devLogTtlMs,
  instanceScope,
  wantsAllInstances
} from '../../../services/api-log-instances.js'

describe('devInstanceKeys (#1052)', () => {
  it('development and test by default, plus the listed extras', () => {
    expect(
      devInstanceKeys(
        { NODE_ENV: 'production', API_LOGS_DEV_INSTANCES: ' laptop-rob , ' },
        'staging'
      )
    ).toEqual(['development', 'test', 'laptop-rob'])
  })
  it('a development process counts its own custom key as dev', () => {
    expect(devInstanceKeys({ NODE_ENV: 'development' }, 'probe-3124')).toContain('probe-3124')
  })
  it('a deployed process never counts its own key as dev, whatever the list says', () => {
    const keys = devInstanceKeys(
      { NODE_ENV: 'production', API_LOGS_DEV_INSTANCES: 'staging' },
      'staging'
    )
    expect(keys).not.toContain('staging')
  })
})

describe('devLogTtlMs', () => {
  it('3 hours unless overridden; 0 turns pruning off', () => {
    expect(devLogTtlMs({})).toBe(DEV_LOG_TTL_MS)
    expect(devLogTtlMs({ API_LOGS_DEV_TTL_HOURS: '6' })).toBe(6 * 3_600_000)
    expect(devLogTtlMs({ API_LOGS_DEV_TTL_HOURS: '0' })).toBe(0)
  })
})

describe('instanceScope', () => {
  it('?instances=all reads everything', async () => {
    expect(wantsAllInstances({ instances: 'all' })).toBe(true)
    const sc = await instanceScope({ instances: 'all' })
    expect(sc.all).toBe(true)
    expect(sc.sql()).toBe('')
  })
  it('the default keeps NULL (pre-379) rows and drops dev instances', async () => {
    const sc = await instanceScope({})
    expect(sc.all).toBe(false)
    expect(sc.sql('l.instance')).toBe(' AND (l.instance IS NULL OR l.instance NOT IN (?, ?))')
    expect(sc.bindings).toEqual(['development', 'test'])
  })
})
