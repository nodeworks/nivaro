import { describe, expect, it } from 'vitest'
import { buildChainContext } from '../../../extensions/loader.js'
import { currentChain } from '../../../services/chain.js'

describe('ctx.chain', () => {
  it('begin runs fn inside a new chain', async () => {
    const chain = buildChainContext()
    const seen = await chain.begin({ source: 'test', ref: '1' }, async () => chain.current())
    expect(seen?.chain_id).toBeTruthy()
    expect(currentChain()).toBeNull()
  })

  it('fields returns {} for a table outside the chain tables', async () => {
    const chain = buildChainContext()
    const out = await chain.begin({ source: 'test', ref: '2' }, () =>
      chain.fields('warehouse_inventory')
    )
    expect(out).toEqual({})
  })
})
