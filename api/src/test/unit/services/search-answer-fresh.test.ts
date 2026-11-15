import { beforeEach, describe, expect, it, vi } from 'vitest'

// rt4 #9 — new records searchable at once: a cached global-search answer is dropped the moment
// a collection it searched is written (this process's write, or another replica's relayed by
// its record event), and a full-text arm also LIKE-matches the newest rows the index has not
// read yet. "Before" = the plain 20 s answer cache; "after" = fresh on the next look.

let tenant = ''
vi.mock('../../../db/index.js', () => ({ db: { raw: vi.fn() } }))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => tenant }))

import { _resetReadCaches, noteCollectionWrite } from '../../../services/read-caches.js'
import {
  searchAnswerCache,
  searchAnswerOutdated,
  searchStamp,
  stampSearchAnswer
} from '../../../services/search-fts.js'

const user = { id: 'U1', role: 'R1' }

/** One search run: what it found when it ran, stamped as the route does. */
function runner(found: () => string[]) {
  let runs = 0
  const run = async () => {
    runs++
    const stamp = searchStamp(['workflows', 'vendors', 'nivaro_users'])
    return stampSearchAnswer({ records: found() }, stamp)
  }
  return { run, runs: () => runs }
}

beforeEach(() => {
  tenant = ''
  searchAnswerCache.forget()
  _resetReadCaches()
})

describe('search answer freshness (rt4 #9)', () => {
  it('a record created after a search is found on the very next identical search', async () => {
    const rows = ['ACME 1']
    const r = runner(() => [...rows])
    const first = await searchAnswerCache.get({ user, q: 'acme' }, r.run)
    expect(first).toEqual({ records: ['ACME 1'] })

    // Someone creates a matching workflow (the items service broadcasts it).
    rows.push('ACME 2')
    noteCollectionWrite('workflows')

    const second = await searchAnswerCache.get({ user, q: 'acme' }, r.run)
    expect(second).toEqual({ records: ['ACME 1', 'ACME 2'] })
    expect(r.runs()).toBe(2)
  })

  it('a write to a collection the search did not cover keeps the cached answer', async () => {
    const r = runner(() => ['x'])
    await searchAnswerCache.get({ user, q: 'acme' }, r.run)
    noteCollectionWrite('invoices')
    await searchAnswerCache.get({ user, q: 'acme' }, r.run)
    expect(r.runs()).toBe(1)
  })

  it('collection names compare case-insensitively and per tenant', async () => {
    const r = runner(() => ['x'])
    await searchAnswerCache.get({ user, q: 'acme' }, r.run)
    noteCollectionWrite('Workflows', 'other-tenant')
    await searchAnswerCache.get({ user, q: 'acme' }, r.run)
    expect(r.runs()).toBe(1)
    noteCollectionWrite('Workflows')
    await searchAnswerCache.get({ user, q: 'acme' }, r.run)
    expect(r.runs()).toBe(2)
  })

  it('a new person (directory write) refreshes the people part', async () => {
    const r = runner(() => ['x'])
    await searchAnswerCache.get({ user, q: 'beth' }, r.run)
    noteCollectionWrite('nivaro_users')
    await searchAnswerCache.get({ user, q: 'beth' }, r.run)
    expect(r.runs()).toBe(2)
  })

  it('an answer without a stamp keeps the plain short cache (the old behaviour)', async () => {
    let runs = 0
    const run = async () => {
      runs++
      return { records: [] }
    }
    await searchAnswerCache.get({ user, q: 'acme' }, run)
    noteCollectionWrite('workflows')
    await searchAnswerCache.get({ user, q: 'acme' }, run)
    expect(runs).toBe(1)
  })

  it('the stamp is never serialised into the answer sent to the browser', () => {
    const a = stampSearchAnswer({ records: [1] }, searchStamp(['workflows']))
    expect(JSON.stringify(a)).toBe('{"records":[1]}')
    expect(Object.keys(a)).toEqual(['records'])
  })

  it('searchAnswerOutdated reads only stamped objects', () => {
    expect(searchAnswerOutdated(null)).toBe(false)
    expect(searchAnswerOutdated({ records: [] })).toBe(false)
    const a = stampSearchAnswer({}, searchStamp(['vendors']))
    expect(searchAnswerOutdated(a)).toBe(false)
    noteCollectionWrite('vendors')
    expect(searchAnswerOutdated(a)).toBe(true)
  })
})
