/**
 * Why a row of a move's file copy failed, in words a move can repeat (never a path, a URL or an
 * error's own text). The target's pull (pull.ts) counts every failed row under one reason; the
 * Hub's link clients read the counts back (only these keys, only whole numbers) and the move run
 * names them in its FILES_NOT_COPIED sentence.
 *
 *  - `source_read_failed`: the source answered 503 SOURCE_READ_FAILED — it could not read its own
 *    stored object (an unreadable or unmounted FILES_FALLBACK_DIR, a throttled bucket …);
 *  - `unreachable`: no answer (connection, timeout, redirect) or a 502/503/504 from on the way;
 *  - `bad_answer`: an answer that is not a Nivaro source's (another status, no name or length,
 *    too big, another key);
 *  - `incomplete`: the bytes stopped or did not match their length;
 *  - `write_failed`: the target could not store the object.
 */
export const PULL_FAIL_REASONS = [
  'source_read_failed',
  'unreachable',
  'bad_answer',
  'incomplete',
  'write_failed'
] as const
export type PullFailReason = (typeof PULL_FAIL_REASONS)[number]
export type PullFailReasons = Partial<Record<PullFailReason, number>>

/** The counts an answer carries: known reasons with a whole count above 0 only. */
export function pullFailReasonsFrom(raw: unknown): PullFailReasons {
  const out: PullFailReasons = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const k of PULL_FAIL_REASONS) {
    const n = (raw as Record<string, unknown>)[k]
    if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) out[k] = n
  }
  return out
}

const SAY: Record<PullFailReason, string> = {
  source_read_failed: 'the source could not read',
  unreachable: 'the source did not answer for',
  bad_answer: 'the source sent an unusable answer for',
  incomplete: 'the bytes arrived incomplete for',
  write_failed: 'the target could not store'
}

/** "the source could not read 3; the target could not store 1" — empty when there are none. */
export function pullFailSentence(reasons: PullFailReasons | undefined): string {
  const r = pullFailReasonsFrom(reasons)
  return PULL_FAIL_REASONS.filter((k) => r[k])
    .map((k) => `${SAY[k]} ${r[k]}`)
    .join('; ')
}
