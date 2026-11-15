/**
 * Merge rules for a field two people saved differently (realtime round 2, item 1).
 *
 * When someone else's save lands on a field the person is still editing, the
 * form offers Keep mine / Take theirs and, where it makes sense, Merge:
 *
 *   - long text (textarea, markdown, code, rich text) → per line / paragraph:
 *     parts only one side changed take that side; parts both changed are the
 *     person's pick (yours, theirs or both). Plain text stays editable after.
 *   - sets (tags, multi-select, a JSON array of plain values) → union of both,
 *     with what either side REMOVED shown (and honoured) so it can be put back.
 *   - everything else (numbers, dates, a single choice, yes/no, links) → no
 *     merge: one value wins, keep or take.
 *
 * Three-way where the value the edit started from (base) is known; a missing
 * base falls back to a plain two-way union / pick. Pure leaf module (no React,
 * no DOM) — the line merge (line-merge.ts) uses the same rules per cell.
 */

export type FieldMergeKind = 'text' | 'rich' | 'set' | 'none'

const TEXT_IFACES = new Set(['textarea', 'markdown', 'code', 'input-multiline'])
// `rich_text` / `rich-text-html` are the names the record form also treats as rich text.
const RICH_IFACES = new Set([
  'wysiwyg',
  'rich_text',
  'rich-text-html',
  'input-rich-text-html',
  'input-rich-text-md'
])
const BLOCK_HTML = /<(p|div|ul|ol|li|h[1-6]|br)\b/i
const SET_IFACES = new Set([
  'tags',
  'select-multiple-dropdown',
  'select-multiple-checkbox',
  'select-multiple-checkbox-tree',
  'checkboxes'
])

const isPlain = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/** A stored set value as a list: an array, a JSON array string, or (tags) a comma list. */
export function setItems(v: unknown): Array<string | number | boolean> | null {
  if (v == null || v === '') return []
  if (Array.isArray(v)) return v.every(isPlain) ? (v as Array<string | number | boolean>) : null
  if (typeof v === 'string') {
    const s = v.trim()
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s)
        return Array.isArray(parsed) && parsed.every(isPlain) ? parsed : null
      } catch {
        return null
      }
    }
    return s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return null
}

/** Write a merged list back in the shape the field holds (`like` = the person's own value). */
export function setValueLike(items: Array<string | number | boolean>, like: unknown): unknown {
  if (Array.isArray(like)) return items
  if (typeof like === 'string' && !like.trim().startsWith('[') && like.trim() !== '')
    return items.join(',')
  return items.length > 0 ? JSON.stringify(items) : null
}

/** Which merge a field offers for these two values. */
export function fieldMergeKind(
  field: { interface?: string | null; type?: string | null } | null | undefined,
  mine: unknown,
  theirs: unknown
): FieldMergeKind {
  const iface = String(field?.interface ?? '')
  const type = String(field?.type ?? '')
  if (RICH_IFACES.has(iface)) return 'rich'
  if (TEXT_IFACES.has(iface)) return 'text'
  if (SET_IFACES.has(iface) || type === 'csv') {
    return setItems(mine) && setItems(theirs) ? 'set' : 'none'
  }
  // A plain JSON list on both sides (a multi-value field with a custom interface).
  if ((type === 'json' || Array.isArray(mine)) && Array.isArray(mine) && Array.isArray(theirs))
    return mine.every(isPlain) && theirs.every(isPlain) ? 'set' : 'none'
  // No interface known (meta not read yet, or an unregistered field): paragraph markup on both
  // sides is rich text.
  if (
    !iface &&
    typeof mine === 'string' &&
    typeof theirs === 'string' &&
    BLOCK_HTML.test(mine) &&
    BLOCK_HTML.test(theirs)
  )
    return 'rich'
  // Long plain text without a text-area interface still merges by line.
  if (
    (type === 'text' || type === 'string') &&
    typeof mine === 'string' &&
    typeof theirs === 'string'
  )
    return /\n/.test(mine) || /\n/.test(theirs) ? 'text' : 'none'
  return 'none'
}

// ── Sets ────────────────────────────────────────────────────────────────────

export interface SetMergeItem {
  value: string | number | boolean
  inMine: boolean
  inTheirs: boolean
  /** Who took it out since the base: 'mine' = the person, 'theirs' = the other save. */
  removedBy: 'mine' | 'theirs' | null
  /** Who put it in since the base (null = it was there before, or no base). */
  addedBy: 'mine' | 'theirs' | 'both' | null
  /** In the merged value unless the person flips it. */
  keep: boolean
}

const key = (v: unknown) => (typeof v === 'string' ? `s:${v}` : `${typeof v}:${String(v)}`)

/**
 * Union of both sets with removals honoured: something one side removed while
 * the other left it alone stays removed (and is listed, so it can be kept);
 * everything either side has, or added, stays. Order: theirs, then the
 * person's additions, then the removed ones.
 */
export function mergeSetValues(base: unknown, mine: unknown, theirs: unknown): SetMergeItem[] {
  const b = setItems(base)
  const m = setItems(mine) ?? []
  const t = setItems(theirs) ?? []
  const has = (list: unknown[], v: unknown) => list.some((x) => key(x) === key(v))
  const order: Array<string | number | boolean> = []
  const seen = new Set<string>()
  for (const v of [...t, ...m, ...(b ?? [])]) {
    if (seen.has(key(v))) continue
    seen.add(key(v))
    order.push(v)
  }
  return order
    .map((value) => {
      const inMine = has(m, value)
      const inTheirs = has(t, value)
      const inBase = b ? has(b, value) : null
      let removedBy: SetMergeItem['removedBy'] = null
      let addedBy: SetMergeItem['addedBy'] = null
      if (inBase === true) {
        if (!inMine && inTheirs) removedBy = 'mine'
        else if (inMine && !inTheirs) removedBy = 'theirs'
      } else if (inBase === false) {
        addedBy = inMine && inTheirs ? 'both' : inMine ? 'mine' : inTheirs ? 'theirs' : null
      }
      // Gone from both sides (removed by both) is not offered at all below.
      const keep = removedBy ? false : inMine || inTheirs
      return { value, inMine, inTheirs, removedBy, addedBy, keep }
    })
    .filter((i) => i.inMine || i.inTheirs)
}

/** The merged set as a list, honouring the person's flips (value key → keep). */
export function mergedSet(
  items: SetMergeItem[],
  flips?: ReadonlyMap<string, boolean>
): Array<string | number | boolean> {
  return items.filter((i) => flips?.get(setItemKey(i.value)) ?? i.keep).map((i) => i.value)
}

export const setItemKey = (v: unknown) => key(v)

// ── Long text ───────────────────────────────────────────────────────────────

export type HunkPick = 'mine' | 'theirs' | 'both'

export interface TextHunk {
  /** Blocks both sides share (shown dimmed, never asked). */
  same: boolean
  mine: string[]
  theirs: string[]
  /** Both sides changed this part from the base (or no base is known): the person decides. */
  conflict: boolean
  /** What the merge takes unless the person picks otherwise. */
  pick: HunkPick
}

/** Rich text splits after each block element; plain text by line. */
export function splitBlocks(text: unknown, rich: boolean): string[] {
  const s = text == null ? '' : String(text)
  if (s === '') return []
  if (!rich) return s.split('\n')
  return s
    .split(/(?<=<\/(?:p|li|h[1-6]|div|blockquote|pre|ul|ol|table|tr)>)/i)
    .filter((x) => x !== '')
}

export function joinBlocks(blocks: string[], rich: boolean): string {
  return rich ? blocks.join('') : blocks.join('\n')
}

/** Longest common subsequence of two block lists, as index pairs. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return out
}

/** Blocks past this count on either side are not diffed (one hunk, keep or take). */
export const MAX_DIFF_BLOCKS = 600

/**
 * The two versions as hunks: shared blocks, and the parts that differ. A
 * differing part only one side changed from the base takes that side; one
 * both changed is a conflict (default: both kept, so nothing is lost until
 * the person picks).
 */
export function diffTextBlocks(
  base: unknown,
  mine: unknown,
  theirs: unknown,
  rich: boolean
): TextHunk[] {
  const m = splitBlocks(mine, rich)
  const t = splitBlocks(theirs, rich)
  const b = base === undefined ? null : splitBlocks(base, rich)
  const baseSet = b ? new Set(b) : null
  const inBase = (blocks: string[]) => !!baseSet && blocks.every((x) => baseSet.has(x))
  const changeHunk = (mine: string[], theirs: string[]): TextHunk => {
    let pick: HunkPick = 'both'
    let conflict = true
    if (baseSet) {
      if (mine.length === 0) {
        // Only theirs has text here: the person deleted it (it was in the base), or they added it.
        pick = inBase(theirs) ? 'mine' : 'theirs'
        conflict = false
      } else if (theirs.length === 0) {
        pick = inBase(mine) ? 'theirs' : 'mine'
        conflict = false
      } else if (inBase(mine) && !inBase(theirs)) {
        pick = 'theirs'
        conflict = false
      } else if (inBase(theirs) && !inBase(mine)) {
        pick = 'mine'
        conflict = false
      } else if (inBase(mine) && inBase(theirs)) {
        pick = 'theirs'
        conflict = false
      }
    }
    return { same: false, mine, theirs, conflict, pick }
  }
  if (m.length > MAX_DIFF_BLOCKS || t.length > MAX_DIFF_BLOCKS) return [changeHunk(m, t)]
  const pairs = lcsPairs(m, t)
  const hunks: TextHunk[] = []
  let i = 0
  let j = 0
  const pushSame = (block: string) => {
    const last = hunks[hunks.length - 1]
    if (last?.same) {
      last.mine.push(block)
      last.theirs.push(block)
    } else hunks.push({ same: true, mine: [block], theirs: [block], conflict: false, pick: 'mine' })
  }
  for (const [pi, pj] of [...pairs, [m.length, t.length] as [number, number]]) {
    if (pi > i || pj > j) {
      const ms = m.slice(i, pi)
      const ts = t.slice(j, pj)
      // The same number of lines changed on both sides: judge them pair by pair, so a line
      // only one person edited is not dragged into the neighbour both edited.
      if (ms.length === ts.length && ms.length > 1)
        ms.forEach((line, k) => hunks.push(changeHunk([line], [ts[k]])))
      else hunks.push(changeHunk(ms, ts))
    }
    if (pi < m.length && pj < t.length) pushSame(m[pi])
    i = pi + 1
    j = pj + 1
  }
  return hunks
}

/** The merged text: each hunk as picked (index → pick overrides the default). */
export function mergedText(
  hunks: TextHunk[],
  picks: ReadonlyMap<number, HunkPick>,
  rich: boolean
): string {
  const out: string[] = []
  hunks.forEach((h, idx) => {
    if (h.same) {
      out.push(...h.mine)
      return
    }
    const pick = picks.get(idx) ?? h.pick
    if (pick === 'mine') out.push(...h.mine)
    else if (pick === 'theirs') out.push(...h.theirs)
    else out.push(...h.mine, ...h.theirs.filter((x) => !h.mine.includes(x)))
  })
  return joinBlocks(out, rich)
}

/** Whether a merge would find anything to ask: some hunk both sides changed. */
export function textNeedsPicks(hunks: TextHunk[]): boolean {
  return hunks.some((h) => h.conflict)
}

// ── One entry for the form ──────────────────────────────────────────────────

/**
 * The value a merge with no picks yields — what "Merge" proposes before the
 * person adjusts it. `none` = no merge (keep or take only).
 */
export function autoMerge(
  kind: FieldMergeKind,
  base: unknown,
  mine: unknown,
  theirs: unknown
): unknown {
  if (kind === 'set') return setValueLike(mergedSet(mergeSetValues(base, mine, theirs)), mine)
  if (kind === 'text' || kind === 'rich') {
    const rich = kind === 'rich'
    return mergedText(diffTextBlocks(base, mine, theirs, rich), new Map(), rich)
  }
  return mine
}
