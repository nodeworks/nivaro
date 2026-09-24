import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/**
 * Integration event chains — which writes belong to which event.
 *
 * One chain = everything one entry point set off: an API request, a cron
 * tick, an import run, or an extension feed event (see chain-roots.ts). The
 * store carries the chain id and the step that is "open" right now; the
 * central writers stamp both onto their rows (chain-columns.ts), and the
 * path service rebuilds the tree from them.
 *
 * Deliberately separate from request-trace.ts: that context carries the
 * request's SQL and timings and is discarded for fast requests.
 *
 * Nested scopes use als.run with a FRESH store — never mutate the current
 * one, or two Promise.all branches in one request overwrite each other's
 * parent.
 */
export interface ChainStore {
  chain_id: string
  parent: string | null
}

const als = new AsyncLocalStorage<ChainStore>()

export function currentChain(): ChainStore | null {
  return als.getStore() ?? null
}

export function newChainId(): string {
  return randomUUID()
}

/** Run `fn` with `stepKey` as the open parent. Outside a chain: plain call. */
export function withChainStep<T>(stepKey: string, fn: () => T): T {
  const cur = als.getStore()
  if (!cur) return fn()
  return als.run({ chain_id: cur.chain_id, parent: stepKey }, fn)
}

/** Start a new chain (cron tick, import run, feed event) and run `fn` in it. */
export function startChain<T>(
  root: string | ((chainId: string) => string),
  fn: () => T,
  chainId: string = newChainId()
): T {
  const parent = typeof root === 'function' ? root(chainId) : root
  return als.run({ chain_id: chainId, parent }, fn)
}
