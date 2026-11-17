/**
 * Compile admin/config-authored regular expressions safely (security audit L-1).
 *
 * Field validation rules, data-quality checks and the like run their regex on the main Node
 * event loop, which has no regex execution timeout. A pattern with catastrophic backtracking
 * (ReDoS) — for example `(a+)+` — against a crafted input runs in exponential time and stalls
 * the whole process (every tenant, in cloud). We refuse such a pattern rather than run it, and
 * callers reject (never truncate) an over-long input. Normal patterns compile and match exactly
 * as before.
 */

/** Longest config-authored pattern we will compile. */
export const MAX_CONFIG_REGEX_PATTERN = 400

/**
 * Longest input a config regex is run against. A longer value is REJECTED by the caller (treated
 * as a validation failure), never truncated — testing a prefix would let the tail bypass the rule.
 */
export const MAX_CONFIG_REGEX_INPUT = 100_000

// Catastrophic-backtracking shapes, tested against a skeleton of the pattern (character classes
// collapsed, escaped chars neutralised — see patternSkeleton), so a literal `+`/`*` inside `[...]`
// or after a backslash is never mistaken for a quantifier:
//   (…x+…)+  — a group whose body carries an unbounded quantifier, the group itself quantified
//              (a+)+, (a*)*, (a+|b)*, (.*)+
//   x+*  )++ — a token followed by two unbounded quantifiers (incl. possessive-looking doubles)
const REDOS_SHAPES: RegExp[] = [/\([^()]*[*+][^()]*\)\s*[*+]/, /[^\\][*+]\??[*+]/]

/**
 * A skeleton of a pattern for the ReDoS screen: every escaped char becomes `x` and every
 * character class `[...]` becomes a single `C`, so quantifier characters that are literals inside
 * a class (`[+*]`) or escaped (`\+`) do not count as quantifiers.
 */
function patternSkeleton(pattern: string): string {
  return pattern
    .replace(/\\./g, 'x') // escaped char → a plain token (\+ \* \( are literals, not operators)
    .replace(/\[(?:[^\]\\]|\\.)*\]/g, 'C') // character class → one token
}

/** True when a pattern is too long, or carries a catastrophic-backtracking shape. */
export function isUnsafeRegex(pattern: string): boolean {
  if (pattern.length > MAX_CONFIG_REGEX_PATTERN) return true
  const skeleton = patternSkeleton(pattern)
  return REDOS_SHAPES.some((re) => re.test(skeleton))
}

/**
 * Compile a config-authored regex, or return null when it is broken OR unsafe (catastrophic
 * backtracking). A null means "do not run this pattern". Callers that must tell the two apart
 * (to fail closed on an unsafe pattern but stay lenient on a typo) call isUnsafeRegex first.
 */
export function compileConfigRegex(pattern: string, flags?: string): RegExp | null {
  if (isUnsafeRegex(pattern)) return null
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}
