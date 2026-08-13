import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetApiVersionWatch,
  checkApiVersion,
  getApiUpdate,
  startApiVersionWatch
} from './api-version'

/** These run without a window, so startApiVersionWatch only registers the
 *  fetcher — it starts no timer and fires no implicit first check. Every poll
 *  below is therefore explicit and ordered. */
function watcher(versions: Array<string | null>) {
  let i = 0
  return () => {
    const v = versions[Math.min(i++, versions.length - 1)]
    return Promise.resolve(v === null ? null : { version: v, environment: 'staging' })
  }
}

describe('api version watch', () => {
  beforeEach(() => {
    __resetApiVersionWatch()
  })

  it('takes the first reported version as the baseline and stays quiet', async () => {
    startApiVersionWatch(watcher(['0.1.23']))
    await checkApiVersion()
    expect(getApiUpdate()).toBeNull()
  })

  it('flags an update when the served version changes', async () => {
    startApiVersionWatch(watcher(['0.1.23', '0.1.24']))
    await checkApiVersion() // baseline 0.1.23
    await checkApiVersion()
    expect(getApiUpdate()?.version).toBe('0.1.24')
    expect(getApiUpdate()?.environment).toBe('staging')
  })

  it('latches — a poll that lands back on the old replica does not clear it', async () => {
    startApiVersionWatch(watcher(['0.1.23', '0.1.24', '0.1.23']))
    await checkApiVersion()
    await checkApiVersion()
    const flagged = getApiUpdate()
    await checkApiVersion()
    expect(getApiUpdate()).toEqual(flagged)
  })

  it('ignores a dev placeholder version', async () => {
    startApiVersionWatch(watcher(['0.0.0-dev', '0.0.0-dev']))
    await checkApiVersion()
    await checkApiVersion()
    expect(getApiUpdate()).toBeNull()
  })

  it('stays quiet when the endpoint is unreachable', async () => {
    startApiVersionWatch(watcher([null, null]))
    await checkApiVersion()
    await checkApiVersion()
    expect(getApiUpdate()).toBeNull()
  })

  it('does not treat the first successful poll after failures as a change', async () => {
    startApiVersionWatch(watcher([null, '0.1.24', '0.1.24']))
    await checkApiVersion() // fails outright — no baseline recorded
    await checkApiVersion()
    expect(getApiUpdate()).toBeNull()
  })
})
