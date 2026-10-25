/**
 * LIKE pattern pieces for filter text. In T-SQL `%` and `_` are wildcards and
 * `[...]` is a character class, so a `_contains` value of "[ARMY TEST]" matched
 * nothing and "100%" / "a_b" matched unrelated rows. Bracketing a special
 * character makes it literal; `]` alone is already literal.
 */
export function likeEscape(value: unknown): string {
  return String(value ?? '').replace(/[%_[]/g, (c) => `[${c}]`)
}

export const likeContains = (value: unknown) => `%${likeEscape(value)}%`
export const likeStartsWith = (value: unknown) => `${likeEscape(value)}%`
export const likeEndsWith = (value: unknown) => `%${likeEscape(value)}`

/**
 * A search pattern that may be bound as varchar against a varchar column.
 * The driver binds every string as nvarchar, and comparing a varchar column
 * with an nvarchar value converts the COLUMN for every row (Unicode rules,
 * ~3x slower on a scan: the EFP workflows search 1.2 s → 0.4 s on 85k rows).
 * Only plain printable ASCII is safe: anything else might not exist in the
 * column's code page, and the cast would turn it into a literal '?'.
 */
export function varcharSafePattern(pattern: string): boolean {
  return pattern.length <= 4000 && /^[\x20-\x7e]*$/.test(pattern)
}
