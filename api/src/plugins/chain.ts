import fp from 'fastify-plugin'
import { currentChain, newChainId, startChain } from '../services/chain.js'

declare module 'fastify' {
  interface FastifyRequest {
    /** Integration event chain this request belongs to (plugins/chain.ts). */
    chainId?: string
  }
}

/**
 * Start (or adopt) the integration event chain for every /api request.
 * An in-process app.inject (mwf-ingest createItem, the /graphql alias, flow
 * item-writes) already runs inside its caller's chain and continues it —
 * otherwise one MWF ingest would read as dozens of unrelated inbound calls.
 *
 * Callback-style hook + als.run (via startChain), NOT enterWith: when this is
 * the first onRequest hook it runs synchronously in the socket's async
 * resource, and enterWith would leave the store on that resource — the next
 * request on the same keep-alive connection would then "adopt" the previous
 * request's chain. als.run scopes the rest of the request (every later hook
 * and the handler run inside `done`) and restores the caller afterwards.
 */
export const chainPlugin = fp(async (app) => {
  app.addHook('onRequest', (req, _reply, done) => {
    const path = (req.raw.url ?? req.url).split('?')[0]
    if (!path.startsWith('/api/') && path !== '/files' && path !== '/graphql') return done()
    const existing = currentChain()
    if (existing) {
      req.chainId = existing.chain_id
      return done()
    }
    const id = newChainId()
    req.chainId = id
    startChain(`request:${id}`, () => done(), id)
  })
})
