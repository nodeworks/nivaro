/**
 * Plain-language score for form text (#2682): labels, help text and section
 * intros. Deterministic and pure — the AI only offers rewrites, the score
 * that ranks them (worst first) and judges them (a rewrite must score higher)
 * is this one.
 *
 * Scale 0–100, higher is plainer. Sentences of eight words or more start from
 * Flesch reading ease; shorter text (labels) starts at 100. Both lose points
 * for raw field names, long words, unexplained abbreviations and office
 * jargon, and every lost point names its reason.
 */

export type TextKind = 'label' | 'help' | 'intro'

export interface PlainScore {
  score: number
  level: 'plain' | 'fair' | 'hard'
  reasons: string[]
}

export const PLAIN_AT = 70
export const FAIR_AT = 50

/** Wordy or formal words people stumble on, with the plain word to use. */
export const JARGON: Record<string, string> = {
  utilize: 'use',
  utilise: 'use',
  facilitate: 'help',
  commence: 'start',
  terminate: 'end',
  remit: 'send',
  pursuant: 'under',
  aforementioned: 'this',
  herein: 'here',
  thereof: 'of it',
  prior: 'before',
  subsequent: 'later',
  endeavor: 'try',
  endeavour: 'try',
  ascertain: 'find out',
  expedite: 'speed up',
  indicate: 'show',
  additional: 'more',
  approximately: 'about',
  sufficient: 'enough',
  requisite: 'needed',
  initiate: 'start',
  modify: 'change',
  obtain: 'get',
  provide: 'give',
  purchase: 'buy',
  regarding: 'about',
  require: 'need',
  submit: 'send'
}

/** Words that are jargon only in running text: in a label they are the usual name. */
const LABEL_OK = new Set(['purchase', 'submit', 'additional', 'prior', 'indicate', 'provide'])

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu

export function words(text: string): string[] {
  return String(text ?? '').match(WORD) ?? []
}

/** Vowel-group syllable estimate: good enough to rank, never shown as a number. */
export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!w) return 1
  if (w.length <= 3) return 1
  const trimmed = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '')
  const groups = trimmed.match(/[aeiouy]{1,2}/g)
  return Math.max(1, groups?.length ?? 1)
}

function sentences(text: string): number {
  const parts = text
    .split(/[.!?;:]+(?:\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
  return Math.max(1, parts.length)
}

/** A token that looks like an abbreviation: two or more capitals, no lower case (PO, CAR, ERP). */
function isAbbreviation(token: string): boolean {
  return /^[A-Z][A-Z0-9&]{1,7}$/.test(token) && /[A-Z].*[A-Z]/.test(token)
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

export function levelOf(score: number): PlainScore['level'] {
  return score >= PLAIN_AT ? 'plain' : score >= FAIR_AT ? 'fair' : 'hard'
}

/**
 * Score one piece of text. `known` = terms people already know (glossary
 * terms): their abbreviations cost nothing.
 */
export function plainScore(
  text: string,
  kind: TextKind,
  known: Set<string> = new Set()
): PlainScore {
  const t = String(text ?? '').trim()
  if (!t) return { score: 100, level: 'plain', reasons: [] }
  const reasons: string[] = []
  const list = words(t)
  const n = Math.max(1, list.length)
  let score = 100
  if (n >= 8 && kind !== 'label') {
    const syll = list.reduce((s, w) => s + countSyllables(w), 0)
    score = 206.835 - 1.015 * (n / sentences(t)) - 84.6 * (syll / n)
    if (n / sentences(t) > 22) reasons.push('long sentences')
    if (syll / n > 1.7) reasons.push('many long words')
  }

  if (/[a-z0-9]_[a-z0-9]/i.test(t) || /\b[a-z]+[A-Z][a-z]+\b/.test(t)) {
    score -= 30
    reasons.push('reads like a raw field name')
  }
  const longWords = list.filter((w) => countSyllables(w) >= 4 && !/^[A-Z0-9]+$/.test(w))
  if (longWords.length && (kind === 'label' || n < 8)) {
    score -= 12 * Math.min(2, longWords.length)
    reasons.push(
      `long word${longWords.length === 1 ? '' : 's'}: ${longWords.slice(0, 2).join(', ')}`
    )
  }
  const abbr = [...new Set(list.filter((w) => isAbbreviation(w) && !known.has(w.toLowerCase())))]
  if (abbr.length) {
    score -= 10 * Math.min(3, abbr.length)
    reasons.push(`abbreviation${abbr.length === 1 ? '' : 's'}: ${abbr.slice(0, 3).join(', ')}`)
  }
  const jargon = [
    ...new Set(
      list
        .map((w) => w.toLowerCase())
        .filter((w) => JARGON[w] && !(kind === 'label' && LABEL_OK.has(w)))
    )
  ]
  if (jargon.length) {
    score -= 12 * Math.min(3, jargon.length)
    reasons.push(
      `formal word${jargon.length === 1 ? '' : 's'}: ${jargon
        .slice(0, 3)
        .map((w) => `${w} (say ${JARGON[w]})`)
        .join(', ')}`
    )
  }
  if (kind === 'label' && n > 6) {
    score -= 5 * (n - 6)
    reasons.push('long for a label')
  }
  if (kind !== 'label' && t.length > 280) {
    score -= 10
    reasons.push('long — people skim')
  }
  const s = clamp(score)
  return { score: s, level: levelOf(s), reasons }
}

/**
 * The rules' own rewrite, used when no AI is set up: raw names become words
 * and formal words become the plain ones. Null when nothing changes.
 */
export function plainRewrite(text: string, kind: TextKind): string | null {
  let out = String(text ?? '')
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/i.test(out.trim()))
    out = out
      .trim()
      .replace(/_/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase())
  out = out.replace(/\bpursuant to\b/gi, (m) => (/^P/.test(m) ? 'Under' : 'under'))
  out = out.replace(WORD, (w) => {
    const plain = JARGON[w.toLowerCase()]
    if (!plain || (kind === 'label' && LABEL_OK.has(w.toLowerCase()))) return w
    return /^[A-Z]/.test(w) ? plain.replace(/^\w/, (c) => c.toUpperCase()) : plain
  })
  return out !== text ? out : null
}
