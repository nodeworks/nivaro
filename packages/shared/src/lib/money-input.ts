// ─── Money typed or pasted into a grid cell ──────────────────────────────────
// ONE rule for every money cell (record PlanGrid; efp-new's forecast worksheet
// keeps a twin with the same code in src/pages/forecast-worksheet/money-input.ts
// — its test compares the two without comments — until it can import this
// from @nivaro/react). Army 9 b03 N2: the worksheet
// stripped every comma, so "12,34" became $1,234 and a European "1.234,56"
// became $1.23; the record grid read text with Number(), so "0x10" was $16 and
// "1e3" was $1,000. Both now accept only plain decimal amounts:
//
//   1234 · 1234.5 · .5 · 5. · $1,234.56 · 1 234 · (500) / -500 (negative)
//
// A comma or space is a thousands separator only between full groups of three
// digits (1,234 · 12,345,678.90); anything else ("12,34", "1.234,56",
// "1,2345") is refused with a message that says how to type it. Hex, exponent
// and binary forms are refused. Amounts round to the cent ON THE DIGITS.

/** decimal(12,2) month columns cannot hold more. */
export const MONEY_INPUT_MAX = 9_999_999_999.99

export type MoneyParse =
  | { ok: true; value: number; rounded: boolean }
  | { ok: false; error: string }

const NOT_AN_AMOUNT = 'Enter an amount of zero or more'
const MULTI_CELL = /[\t\r\n]/
const PLAIN = /^(\d+(\.\d*)?|\.\d+)$/
/** Thousands groups with ONE separator kind throughout. */
const GROUPED_COMMA = /^\d{1,3}(,\d{3})+(\.\d*)?$/
const GROUPED_SPACE = /^\d{1,3}( \d{3})+(\.\d*)?$/

/** "1.005" → 1.01 (1.005 × 100 is 100.4999… in floating point). */
function centsOfDigits(s: string): number {
  const shifted = Number(`${s}e2`)
  return Number.isFinite(shifted) ? Math.round(shifted) / 100 : Math.round(Number(s) * 100) / 100
}

/**
 * Text → amount. Empty (or "—" / "-") is 0. Negative amounts come back
 * negative; a caller that only takes zero or more refuses them itself.
 */
export function parseMoneyInput(text: string): MoneyParse {
  const trimmed = String(text ?? '').trim()
  if (MULTI_CELL.test(trimmed)) return { ok: false, error: 'Paste one amount per cell' }
  if (trimmed === '' || trimmed === '—' || trimmed === '-')
    return { ok: true, value: 0, rounded: false }
  let s = trimmed
  let negative = false
  if (/^\(.*\)$/.test(s)) {
    negative = true
    s = s.slice(1, -1).trim()
  }
  // A minus and a dollar sign, each at most once, in either order: "-$5",
  // "$-5", "($5)" (army 9 review L6: "$-5" was refused).
  let dollar = false
  for (;;) {
    if (s.startsWith('-')) {
      if (negative) return { ok: false, error: NOT_AN_AMOUNT }
      negative = true
      s = s.slice(1).trim()
    } else if (s.startsWith('$')) {
      if (dollar) return { ok: false, error: NOT_AN_AMOUNT }
      dollar = true
      s = s.slice(1).trim()
    } else break
  }
  // Runs of spaces collapse; a lone space is still a separator to judge.
  s = s.replace(/\s+/g, ' ')
  let digits: string
  if (PLAIN.test(s)) digits = s
  else if (GROUPED_COMMA.test(s)) digits = s.replace(/,/g, '')
  else if (GROUPED_SPACE.test(s)) digits = s.replace(/ /g, '')
  else if (/^[\d., ]+$/.test(s) && /,/.test(s))
    return {
      ok: false,
      error: `"${trimmed}" is not clear — use a comma only between thousands (1,234) and a point for cents (12.34)`
    }
  else return { ok: false, error: NOT_AN_AMOUNT }
  const exact = Number(digits)
  if (!Number.isFinite(exact)) return { ok: false, error: NOT_AN_AMOUNT }
  if (exact > MONEY_INPUT_MAX)
    return { ok: false, error: 'That is more than a month can hold ($9,999,999,999.99)' }
  const value = centsOfDigits(digits)
  return {
    ok: true,
    value: negative && value !== 0 ? -value : value,
    rounded: Math.abs(exact - value) > 1e-9
  }
}
