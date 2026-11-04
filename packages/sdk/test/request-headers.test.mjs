// Per-call headers (withHeaders / Command._headers, 2026-11-04): one command carries its own
// header (the requirements dialog names the move it saves for) without changing the client's
// headers for every other call. Runs against the built dist: `pnpm run build && pnpm test`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createNivaro, updateItem, withHeaders } from '../dist/index.js'

function fakeFetch() {
  const inits = []
  const fetch = async (_url, init) => {
    inits.push(init)
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: { id: 7 } })
    }
  }
  return { fetch, inits }
}

describe('request() with per-call headers', () => {
  it('sends the command headers on that call only', async () => {
    const { fetch, inits } = fakeFetch()
    const c = createNivaro('http://x', { fetch, headers: { 'x-nivaro-app': 'admin' } })
    const cmd = updateItem('lines', 7, { req_no: 'R-1' })
    await c.request(withHeaders(cmd, { 'x-nivaro-requirements-for': 'T-1' }))
    await c.request(cmd)
    assert.equal(inits[0].headers['x-nivaro-requirements-for'], 'T-1')
    assert.equal(inits[0].headers['x-nivaro-app'], 'admin')
    assert.equal(inits[1].headers['x-nivaro-requirements-for'], undefined)
  })

  it("never lets a command's headers replace the client's own", async () => {
    const { fetch, inits } = fakeFetch()
    const c = createNivaro('http://x', { fetch, token: 'tok' })
    await c.request(
      withHeaders(updateItem('lines', 7, {}), {
        Authorization: 'Bearer other',
        'Content-Type': 'text/plain'
      })
    )
    assert.equal(inits[0].headers.Authorization, 'Bearer tok')
    assert.equal(inits[0].headers['Content-Type'], 'application/json')
  })

  it('returns the command unchanged without headers', () => {
    const cmd = updateItem('lines', 7, {})
    assert.equal(withHeaders(cmd, undefined), cmd)
  })
})
