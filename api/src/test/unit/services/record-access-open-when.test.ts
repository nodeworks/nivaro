import { describe, expect, it, vi } from 'vitest'

// Review round 1, item 6: when the owner question itself cannot be answered,
// the gate still asks open_when — the same answer the lists that offer moves
// give — so an offered button is never then refused. Without an open_when it
// refuses, as before.

vi.mock('../../../db/index.js', () => {
  const boom = vi.fn(() => {
    throw new Error('db down')
  })
  return { db: Object.assign(boom, { raw: boom }), dbRead: boom }
})

import { checkTransitionOwner } from '../../../services/record-access.js'

const base = {
  user: { id: 'u-1', role: 'r' } as never,
  isAdmin: false,
  collection: 'workflows',
  item: '7',
  instanceId: 'inst-1'
}

describe('checkTransitionOwner when the owner question fails', () => {
  it('passes a move open to anyone on this collection', async () => {
    const r = await checkTransitionOwner({ ...base, openWhen: '{"workflows":[]}' })
    expect(r).toMatchObject({ allowed: true, open: true })
  })

  it('refuses without an open_when, or one that cannot be judged', async () => {
    expect((await checkTransitionOwner(base)).message).toBe(
      'Could not confirm you own the current step.'
    )
    const r = await checkTransitionOwner({
      ...base,
      openWhen: '[{"field":"$state","op":"neq","value":"waiting_on_po"}]'
    })
    expect(r.allowed).toBe(false)
    expect(r.message).toBe('Could not confirm you own the current step.')
  })
})
