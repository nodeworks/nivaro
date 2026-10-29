import { describe, expect, it } from 'vitest'
import {
  CANONICAL_COLUMNS,
  canonicalRow,
  GENESIS_HASH,
  sealHash
} from '../../../../services/activity-trail/canonical.js'
import {
  type Anchor,
  type Bridge,
  computeSeals,
  planBridges,
  verifyWalk,
  type WalkRow
} from '../../../../services/activity-trail/chain.js'

// #16 — the tamper-evident activity trail, end to end over an in-memory table: sealing,
// verification, tamper detection, and retention purges that leave bridges + checkpoints.

const GOLDEN_CANONICAL =
  '{"id":42,"timestamp":"2026-10-29T12:34:56.789Z","action":"update","user":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","ip":"10.0.0.1","user_agent":null,"collection":"articles","item":"7","comment":"hi \\"there\\"","origin":null,"legacy_id":null,"chain_id":null,"chain_parent":null,"api_key_id":null,"auth_method":null,"mcp_conn":null,"via_app":null}'
const GOLDEN_HASH = '4629ef40e596f571254f7cd231f92fa25b1164b1ec8b7ba133fa5fbcefcde351'

const golden = {
  id: 42,
  timestamp: new Date('2026-10-29T12:34:56.789Z'),
  action: 'update',
  user: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
  collection: 'articles',
  item: '7',
  comment: 'hi "there"',
  ip: '10.0.0.1'
}

describe('canonical form (v1)', () => {
  it('is byte-for-byte stable — a change here invalidates every sealed row', () => {
    expect(canonicalRow(golden, 1)).toBe(GOLDEN_CANONICAL)
    expect(sealHash(GENESIS_HASH, canonicalRow(golden, 1))).toBe(GOLDEN_HASH)
  })

  it('does not depend on how the driver handed the row over', () => {
    const asStrings = {
      // a string timestamp, lower-case uuid, string id, columns in another order
      via_app: null,
      comment: 'hi "there"',
      item: '7',
      collection: 'articles',
      ip: '10.0.0.1',
      user: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      action: 'update',
      timestamp: '2026-10-29T12:34:56.789Z',
      id: '42'
    }
    expect(canonicalRow(asStrings, 1)).toBe(GOLDEN_CANONICAL)
  })

  it('ignores columns outside v1 (a later migration cannot change old hashes)', () => {
    expect(canonicalRow({ ...golden, seal_hash: 'x', some_new_column: 'y', revision: 3 }, 1)).toBe(
      GOLDEN_CANONICAL
    )
  })

  it('lists its columns explicitly, id first', () => {
    expect(CANONICAL_COLUMNS[1][0]).toBe('id')
    expect(CANONICAL_COLUMNS[1]).toContain('timestamp')
    expect(CANONICAL_COLUMNS[1]).not.toContain('seal_hash')
  })
})

// ── An in-memory nivaro_activity with the sealer / purge / verify rules ─────────────────

interface Row extends Record<string, unknown> {
  id: number
  action: string
  timestamp: string
  comment: string | null
  collection: string
  item: string
  seal_seq: number | null
  seal_hash: string | null
  seal_version: number | null
}

class Table {
  rows = new Map<number, Row>()
  bridges = new Map<number, Bridge>()
  private nextId = 1

  insert(n: number, collection = 'articles'): number[] {
    const ids: number[] = []
    for (let i = 0; i < n; i++) {
      const id = this.nextId++
      this.rows.set(id, {
        id,
        action: 'update',
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
        comment: `entry ${id}`,
        collection,
        item: String(id % 5),
        seal_seq: null,
        seal_hash: null,
        seal_version: null
      })
      ids.push(id)
    }
    return ids
  }

  head(): Anchor {
    let best: Anchor = { seq: 0, hash: GENESIS_HASH }
    for (const r of this.rows.values())
      if (r.seal_seq != null && r.seal_seq > best.seq)
        best = { seq: r.seal_seq, hash: r.seal_hash! }
    return best
  }

  /** The sealer: unsealed rows in id order, chained to the head. */
  seal(): void {
    const unsealed = [...this.rows.values()]
      .filter((r) => r.seal_hash == null)
      .sort((a, b) => a.id - b.id)
    for (const s of computeSeals(this.head(), unsealed, 1)) {
      const r = this.rows.get(s.id)!
      r.seal_seq = s.seq
      r.seal_hash = s.hash
      r.seal_version = 1
    }
  }

  sealedBySeq(): Row[] {
    return [...this.rows.values()]
      .filter((r) => r.seal_seq != null)
      .sort((a, b) => a.seal_seq! - b.seal_seq!)
  }

  /** purge.ts purgeBatch: bridges first, then the delete. The head is never deleted. */
  purge(ids: number[]): number {
    const headSeq = this.head().seq
    const doomed = ids.filter((id) => {
      const r = this.rows.get(id)
      return r && (r.seal_seq == null || r.seal_seq < headSeq)
    })
    const sealed = doomed
      .map((id) => this.rows.get(id)!)
      .filter((r) => r.seal_seq != null)
      .map((r) => ({ id: r.id, seq: r.seal_seq!, hash: r.seal_hash! }))
    const bySeq = this.sealedBySeq()
    const nextOf = new Map<number, { id: number; seq: number } | null>()
    for (const d of sealed) {
      const n = bySeq.find((r) => r.seal_seq! > d.seq)
      nextOf.set(d.id, n ? { id: n.id, seq: n.seal_seq! } : null)
    }
    const plan = planBridges(sealed, nextOf, new Set(this.bridges.keys()))
    for (const b of plan)
      this.bridges.set(b.activity_id, { prev_hash: b.prev_hash, prev_seq: b.prev_seq })
    for (const id of doomed) {
      this.bridges.delete(id)
      this.rows.delete(id)
    }
    return plan.length
  }

  walk(after: number): WalkRow[] {
    return this.sealedBySeq()
      .filter((r) => r.seal_seq! > after)
      .map((r) => ({
        id: r.id,
        seq: r.seal_seq!,
        hash: r.seal_hash!,
        version: r.seal_version,
        at: r.timestamp,
        row: { ...r }
      }))
  }

  verify(from: Anchor = { seq: 0, hash: GENESIS_HASH }) {
    return verifyWalk(from, this.walk(from.seq), this.bridges)
  }
}

describe('chain', () => {
  it('builds and verifies intact', () => {
    const t = new Table()
    t.insert(50)
    t.seal()
    t.insert(10)
    t.seal()
    const res = t.verify()
    expect(res.rows).toBe(60)
    expect(res.mismatches).toEqual([])
    expect(res.last.seq).toBe(60)
  })

  it('seals late rows after the head (chain order is seal_seq, not id)', () => {
    const t = new Table()
    t.insert(5)
    // row 3 still uncommitted: sealed on a later tick, after 4 and 5
    const late = t.rows.get(3)!
    t.rows.delete(3)
    t.seal()
    t.insert(1)
    t.rows.set(3, late)
    t.seal()
    expect(t.rows.get(3)!.seal_seq).toBe(5)
    expect(t.rows.get(5)!.seal_seq).toBe(4)
    expect(t.verify().mismatches).toEqual([])
  })

  it('detects a tampered row and keeps checking past it', () => {
    const t = new Table()
    t.insert(30)
    t.seal()
    t.rows.get(12)!.comment = 'edited after the fact'
    const res = t.verify()
    expect(res.mismatches).toEqual([{ id: 12, seq: 12, reason: 'changed' }])
    expect(res.rows).toBe(30)
  })

  it('detects a recomputed hash (the next link breaks)', () => {
    const t = new Table()
    t.insert(10)
    t.seal()
    const r = t.rows.get(5)!
    r.comment = 'forged'
    r.seal_hash = sealHash(t.rows.get(4)!.seal_hash!, canonicalRow(r, 1))
    expect(t.verify().mismatches.map((m) => m.id)).toEqual([6])
  })

  it('reports a row deleted outside the purge path as a gap', () => {
    const t = new Table()
    t.insert(10)
    t.seal()
    t.rows.delete(4)
    expect(t.verify().mismatches).toEqual([{ id: 5, seq: 5, reason: 'gap' }])
  })

  it('reports an unknown seal version', () => {
    const t = new Table()
    t.insert(3)
    t.seal()
    t.rows.get(2)!.seal_version = 9
    expect(t.verify().mismatches[0]).toMatchObject({ id: 2, reason: 'version' })
  })
})

describe('retention purges', () => {
  it('a purge of interior rows leaves bridges and the chain still verifies', () => {
    const t = new Table()
    t.insert(40)
    t.seal()
    // per-collection retention: scattered rows, runs of one and of several
    const bridged = t.purge([3, 10, 11, 12, 20, 25, 26])
    expect(bridged).toBe(4)
    const res = t.verify()
    expect(res.mismatches).toEqual([])
    expect(res.bridged).toBe(4)
    expect(res.rows).toBe(33)
  })

  it('purging a bridged row moves the bridge forward', () => {
    const t = new Table()
    t.insert(20)
    t.seal()
    t.purge([5])
    expect(t.bridges.has(6)).toBe(true)
    t.purge([6])
    expect(t.bridges.has(6)).toBe(false)
    expect(t.bridges.get(7)?.prev_seq).toBe(6)
    t.purge([8])
    t.purge([7])
    expect(t.verify().mismatches).toEqual([])
  })

  it('never deletes the head', () => {
    const t = new Table()
    t.insert(5)
    t.seal()
    t.purge([5])
    expect(t.rows.has(5)).toBe(true)
  })

  it('verify restarts from a checkpoint after the rows below it are purged', () => {
    const t = new Table()
    t.insert(30)
    t.seal()
    const first = t.verify()
    expect(first.mismatches).toEqual([])
    const checkpoint: Anchor = { seq: first.last.seq, hash: first.last.hash }
    t.insert(20)
    t.seal()
    // retention removes everything up to and including the checkpoint's own row
    t.purge(Array.from({ length: 30 }, (_, i) => i + 1))
    expect(t.rows.has(30)).toBe(false)
    const res = t.verify(checkpoint)
    expect(res.mismatches).toEqual([])
    expect(res.rows).toBe(20)
    // from genesis the survivors are still bridged back to the purged run
    expect(t.verify().mismatches).toEqual([])
  })

  it('a bridge never launders a gap made outside the purge path', () => {
    const t = new Table()
    t.insert(10)
    t.seal()
    t.rows.delete(4) // tampering: no bridge
    t.purge([3]) // 3's next existing row is 5, not seq 4 → no bridge for 5
    expect(t.bridges.has(5)).toBe(false)
    expect(t.verify().mismatches.map((m) => m.reason)).toContain('gap')
  })

  it('unsealed rows can be purged without touching the chain', () => {
    const t = new Table()
    t.insert(5)
    t.seal()
    const fresh = t.insert(3)
    t.purge([fresh[0]])
    t.seal()
    expect(t.verify().mismatches).toEqual([])
  })
})
