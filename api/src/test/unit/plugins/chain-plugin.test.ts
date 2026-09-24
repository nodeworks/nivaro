import http from 'node:http'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { chainPlugin } from '../../../plugins/chain.js'
import { currentChain, startChain, withChainStep } from '../../../services/chain.js'

async function build() {
  const app = Fastify()
  await app.register(chainPlugin)
  app.get('/api/probe', async () => currentChain())
  // What the api-logger reads off the request. `undefined` would vanish from
  // the JSON, so an unset field reads 'UNSET' — null must come back as null.
  app.get('/api/probe-req', async (req) => ({
    chainId: req.chainId ?? 'UNSET',
    chainParent: req.chainParent === undefined ? 'UNSET' : req.chainParent
  }))
  await app.ready()
  return app
}

describe('chainPlugin', () => {
  it('starts a request chain', async () => {
    const app = await build()
    const res = await app.inject({ method: 'GET', url: '/api/probe' })
    const body = res.json() as { chain_id: string; parent: string }
    expect(body.parent).toBe(`request:${body.chain_id}`)
    // A chain root has no parent — the api-log row must read as the root.
    const reqBody = (await app.inject({ method: 'GET', url: '/api/probe-req' })).json()
    expect(reqBody.chainParent).toBeNull()
    expect(typeof reqBody.chainId).toBe('string')
  })

  it('two injected requests get different chain ids', async () => {
    const app = await build()
    const a = (await app.inject({ method: 'GET', url: '/api/probe' })).json()
    const b = (await app.inject({ method: 'GET', url: '/api/probe' })).json()
    expect(a.chain_id).not.toBe(b.chain_id)
  })

  it("an injected request adopts the caller's chain", async () => {
    const app = await build()
    const body = await startChain(
      'cron:mwf-ingest',
      () =>
        withChainStep('history:3', async () =>
          (await app.inject({ method: 'GET', url: '/api/probe' })).json()
        ),
      'c-ingest'
    )
    expect(body).toEqual({ chain_id: 'c-ingest', parent: 'history:3' })
    // An adopted request's api-log row hangs under the caller's open step.
    const reqBody = await startChain(
      'cron:mwf-ingest',
      () =>
        withChainStep('history:3', async () =>
          (await app.inject({ method: 'GET', url: '/api/probe-req' })).json()
        ),
      'c-ingest'
    )
    expect(reqBody).toEqual({ chainId: 'c-ingest', chainParent: 'history:3' })
  })

  it('ignores non-/api paths', async () => {
    const app = Fastify()
    await app.register(chainPlugin)
    app.get('/assets/x', async () => ({ c: currentChain() }))
    await app.ready()
    expect((await app.inject({ method: 'GET', url: '/assets/x' })).json()).toEqual({ c: null })
  })

  it('keeps the chain through later async hooks and awaits in the handler', async () => {
    const app = Fastify()
    await app.register(chainPlugin)
    app.addHook('onRequest', async () => {
      await new Promise((r) => setTimeout(r, 1))
    })
    app.addHook('preHandler', async () => {
      await new Promise((r) => setTimeout(r, 1))
    })
    app.get('/api/probe', async (req) => {
      await new Promise((r) => setTimeout(r, 1))
      return { store: currentChain(), reqId: req.chainId }
    })
    await app.ready()
    const body = (await app.inject({ method: 'GET', url: '/api/probe' })).json()
    expect(body.store.chain_id).toBe(body.reqId)
    expect(body.store.parent).toBe(`request:${body.reqId}`)
  })

  it('does not leak a chain into the next request on a keep-alive socket', async () => {
    const app = Fastify()
    await app.register(chainPlugin)
    app.get('/api/probe', async () => currentChain())
    app.get('/x', async () => ({ c: currentChain() }))
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const get = (path: string) =>
      new Promise<unknown>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path, agent }, (res) => {
            let data = ''
            res.on('data', (c) => {
              data += c
            })
            res.on('end', () => resolve(JSON.parse(data)))
          })
          .on('error', reject)
      })
    try {
      const a = (await get('/api/probe')) as { chain_id: string }
      const b = (await get('/api/probe')) as { chain_id: string }
      expect(a.chain_id).not.toBe(b.chain_id)
      expect(await get('/x')).toEqual({ c: null })
      expect(currentChain()).toBeNull()
    } finally {
      agent.destroy()
      await app.close()
    }
  })
})
