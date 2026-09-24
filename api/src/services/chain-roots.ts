import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { currentChain, newChainId, startChain } from './chain.js'
import { selectInChunks } from './db-batch.js'

/**
 * nivaro_chain_roots — event rows that live in tables we must not alter
 * (extension feeds, replays) mapped to the chain they started.
 */
const tableProbe = new Map<string, Promise<boolean>>()

async function rootsTableExists(): Promise<boolean> {
  const key = getTenantId() ?? ''
  let p = tableProbe.get(key)
  if (!p) {
    p = (async () => {
      try {
        return await db.schema.hasTable('nivaro_chain_roots')
      } catch {
        return false
      }
    })()
    tableProbe.set(key, p)
    // A miss is not cached forever: a tenant migrates while we run.
    p.then((hit) => {
      if (!hit) setTimeout(() => tableProbe.delete(key), 60_000).unref?.()
    })
  }
  return p
}

export function resetChainRootsProbe(): void {
  tableProbe.clear()
}

export async function beginChainRoot<T>(
  root: { source: string; ref: string; replayOf?: string | null },
  fn: () => Promise<T>
): Promise<T> {
  const chainId = newChainId()
  let rootKey = `root:${root.source}:${root.ref}`.slice(0, 120)
  if (await rootsTableExists()) {
    try {
      const ret = (await db('nivaro_chain_roots')
        .insert({
          chain_id: chainId,
          source: root.source.slice(0, 120),
          ref: root.ref.slice(0, 300),
          replay_of: root.replayOf ?? null,
          created_at: new Date()
        })
        .returning('id')) as Array<number | { id: number }>
      const first = ret[0]
      const id = typeof first === 'object' && first !== null ? first.id : first
      if (id != null) rootKey = `root:${id}`
    } catch {
      // A failed bookkeeping insert never blocks the event itself.
    }
  }
  return startChain(rootKey, fn, chainId)
}

/** Mark the CURRENT chain as a replay of `replayOf` (replay routes). */
export async function recordReplayRoot(opts: {
  source: string
  ref: string
  replayOf: string | null
}): Promise<void> {
  const chain = currentChain()
  if (!chain || !(await rootsTableExists())) return
  try {
    await db('nivaro_chain_roots').insert({
      chain_id: chain.chain_id,
      source: opts.source.slice(0, 120),
      ref: opts.ref.slice(0, 300),
      replay_of: opts.replayOf,
      created_at: new Date()
    })
  } catch {
    // bookkeeping only
  }
}

export async function chainIdsForRoots(
  source: string,
  refs: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (refs.length === 0 || !(await rootsTableExists())) return out
  try {
    const found = await selectInChunks(refs, 1000, (chunk) =>
      db('nivaro_chain_roots')
        .where('source', source)
        .whereIn('ref', chunk)
        .select('ref', 'chain_id')
    )
    for (const r of found as Array<{ ref: string; chain_id: string }>) {
      if (!out.has(String(r.ref))) out.set(String(r.ref), String(r.chain_id))
    }
  } catch {
    // unreadable roots = no chain ids; callers fall back to inference
  }
  return out
}

export async function replayLinks(
  chainId: string
): Promise<{ replay_of: string | null; replayed_as: string[] }> {
  if (!(await rootsTableExists())) return { replay_of: null, replayed_as: [] }
  try {
    const own = await db('nivaro_chain_roots')
      .where('chain_id', chainId)
      .whereNotNull('replay_of')
      .first('replay_of')
    const later = (await db('nivaro_chain_roots')
      .where('replay_of', chainId)
      .select('chain_id')) as Array<{ chain_id: string }>
    return {
      replay_of: own?.replay_of ? String(own.replay_of) : null,
      replayed_as: later.map((r) => String(r.chain_id))
    }
  } catch {
    return { replay_of: null, replayed_as: [] }
  }
}
