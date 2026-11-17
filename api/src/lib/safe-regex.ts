/**
 * Compile and run admin/config-authored regular expressions safely (security audit L-1).
 *
 * Field validation rules, data-quality checks and the like run their regex on the main Node
 * event loop, which has no regex execution timeout. A pattern with catastrophic backtracking
 * (ReDoS) — for example `(a+)+` — against a crafted input runs in exponential time and stalls
 * the whole process (every tenant, in cloud). Rather than run such a pattern, we refuse it at
 * compile time and bound the input length. Normal patterns are unaffected: they compile and
 * match exactly as before.
 */

/** Longest config-authored pattern we will compile. */
export const MAX_CONFIG_REGEX_PATTERN = 400

/** Longest input we will run a config regex against — far above any real field value. */
export const MAX_CONFIG_REGEX_INPUT = 100_000

// Catastrophic-backtracking shapes:
//   (…x+…)+  — a group whose body carries an unbounded quantifier, the group itself quantified
//              (a+)+, (a*)*, (a+|b)*, (.*)+
//   x+*  )++ — a token followed by two unbounded quantifiers (incl. possessive-looking doubles)
const REDOS_SHAPES: RegExp[] = [/\([^()]*[*+][^()]*\)\s*[*+]/, /[^\\][*+]\??[*+]/]

/** True when a pattern is too long, or carries a catastrophic-backtracking shape. */
export function isUnsafeRegex(pattern: string): boolean {
  if (pattern.length > MAX_CONFIG_REGEX_PATTERN) return true
  return REDOS_SHAPES.some((re) => re.test(pattern))
}

/**
 * Compile a config-authored regex, or return null when it is broken OR unsafe (catastrophic
 * backtracking). A null means "do not run this pattern"; the caller decides what that implies.
 */
export function compileConfigRegex(pattern: string, flags?: string): RegExp | null {
  if (isUnsafeRegex(pattern)) return null
  try {
    return new RegExp(pattern, flags)
  } catch {
    return null
  }
}

/** Bound an input to MAX_CONFIG_REGEX_INPUT before it is tested. */
export function boundRegexInput(input: string): string {
  return input.length > MAX_CONFIG_REGEX_INPUT ? input.slice(0, MAX_CONFIG_REGEX_INPUT) : input
}

/**
 * Test input against a config regex with a bounded input length. Returns the boolean result, or
 * null when the pattern is broken/unsafe (validation treats null as "cannot enforce"; a
 * data-quality run surfaces it as a rule error).
 */
export function safeConfigRegexTest(
  pattern: string,
  input: string,
  flags?: string
): boolean | null {
  const re = compileConfigRegex(pattern, flags)
  if (!re) return null
  return re.test(boundRegexInput(input))
}
