import { canonicalRow, isSealVersion, type SealVersion, sealHash } from './canonical.js'

/**
 * Pure chain logic for the tamper-evident activity trail (#16): sealing a run of rows,
 * verifying a walk, and planning the bridges a retention purge must leave behind.
 * No database here — sealer.ts / verify.ts / purge.ts feed it rows.
 *
 * The chain is ordered by seal_seq (the sealer's own counter), not by id: rows can commit out
 * of id order. Each sealed row's hash links to the row at seq - 1. When a retention purge
 * deletes that predecessor, a bridge row keeps its hash so the survivor still verifies; a gap
 * with no bridge is a deletion that did not go through the purge path, and verification says so.
 */

export interface Anchor {
  /** Chain position (0 = before the first row). */
  seq: number
  hash: string
}

export interface SealedRow {
  id: number
  seq: number
  hash: string
}

/** Seal rows (already in the order they join the chain) after the anchor. */
export function computeSeals(
  anchor: Anchor,
  rows: Array<Record<string, unknown>>,
  version: SealVersion
): SealedRow[] {
  const out: SealedRow[] = []
  let prev = anchor
  for (const row of rows) {
    const seq = prev.seq + 1
    const hash = sealHash(prev.hash, canonicalRow(row, version))
    out.push({ id: Number(row.id), seq, hash })
    prev = { seq, hash }
  }
  return out
}

export interface WalkRow {
  id: number
  seq: number
  hash: string
  version: number | null
  at?: Date | string | null
  row: Record<string, unknown>
}

export interface Bridge {
  prev_hash: string
  prev_seq: number
}

export type MismatchReason = 'changed' | 'gap' | 'version'

export interface Mismatch {
  id: number
  seq: number
  reason: MismatchReason
}

export interface WalkResult {
  /** Where the walk ended (the last row read; after a mismatch the walk re-anchors on it). */
  last: Anchor & { id: number | null; at: Date | string | null }
  rows: number
  bridged: number
  mismatches: Mismatch[]
  /** Previous-hash each row was checked against (evidence export lists it). */
  prevHashes?: Map<number, string>
}

export const MISMATCH_TEXT: Record<MismatchReason, string> = {
  changed: 'This entry was changed after it was sealed',
  gap: 'Entries before this one are missing (deleted outside the retention purge)',
  version: 'This entry carries a seal version this build does not know'
}

/**
 * Verify rows (sorted by seq, all > anchor.seq) against the anchor. A mismatch is recorded and
 * the walk continues from the row's stored hash, so one break does not hide the rest.
 */
export function verifyWalk(
  anchor: Anchor & { id?: number | null; at?: Date | string | null },
  rows: WalkRow[],
  bridges: Map<number, Bridge>,
  opts: { keepPrev?: boolean; maxMismatches?: number } = {}
): WalkResult {
  const res: WalkResult = {
    last: { seq: anchor.seq, hash: anchor.hash, id: anchor.id ?? null, at: anchor.at ?? null },
    rows: 0,
    bridged: 0,
    mismatches: [],
    prevHashes: opts.keepPrev ? new Map() : undefined
  }
  const cap = opts.maxMismatches ?? 1000
  let prev: Anchor = anchor
  for (const r of rows) {
    res.rows++
    let expectedPrev: string | null = null
    if (r.seq === prev.seq + 1) expectedPrev = prev.hash
    else {
      const b = bridges.get(r.id)
      if (b && b.prev_seq === r.seq - 1 && b.prev_seq >= prev.seq) {
        expectedPrev = b.prev_hash
        res.bridged++
      }
    }
    let reason: MismatchReason | null = null
    if (expectedPrev == null) reason = 'gap'
    else if (!isSealVersion(r.version)) reason = 'version'
    else if (sealHash(expectedPrev, canonicalRow(r.row, r.version)) !== r.hash) reason = 'changed'
    if (res.prevHashes && expectedPrev) res.prevHashes.set(r.id, expectedPrev)
    if (reason && res.mismatches.length < cap) res.mismatches.push({ id: r.id, seq: r.seq, reason })
    prev = { seq: r.seq, hash: r.hash }
    res.last = { seq: r.seq, hash: r.hash, id: r.id, at: r.at ?? null }
  }
  return res
}

/**
 * The bridges a purge must write before deleting `deleted`: for every sealed deleted row whose
 * next existing row survives and sat right after it (seq + 1), that survivor keeps the deleted
 * row's hash. A survivor that already has a bridge keeps it (its own predecessor went earlier);
 * a survivor separated by an unexplained gap gets none (verification keeps reporting the gap).
 */
export function planBridges(
  deleted: SealedRow[],
  nextOf: Map<number, { id: number; seq: number } | null>,
  alreadyBridged: Set<number>
): Array<{ activity_id: number; prev_hash: string; prev_seq: number }> {
  const deletedIds = new Set(deleted.map((d) => d.id))
  const out: Array<{ activity_id: number; prev_hash: string; prev_seq: number }> = []
  for (const d of deleted) {
    const n = nextOf.get(d.id)
    if (!n || deletedIds.has(n.id) || alreadyBridged.has(n.id)) continue
    if (n.seq !== d.seq + 1) continue
    out.push({ activity_id: n.id, prev_hash: d.hash, prev_seq: d.seq })
  }
  return out
}
