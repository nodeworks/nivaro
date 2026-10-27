// What the bug reporter strips before a report leaves the browser (security
// audit 2026-10-27, frontend Lows): console lines can carry bearer tokens,
// ws/stream tickets and signed URLs; the screenshot can show password fields
// and regions the app already marks as never-record.

const REDACTED = '[redacted]'

const LINE_RULES: Array<[RegExp, string]> = [
  // Authorization headers and bare bearer values
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, REDACTED],
  // Nivaro token families (API keys, OAuth, run-as, masquerade, refresh…)
  [/\bnv[a-z]_[A-Za-z0-9_-]{8,}/g, REDACTED],
  // key=value / "key": "value" pairs whose key names a secret (query strings, JSON)
  [
    /\b((?:access_|refresh_|id_|ws_|stream_|static_)?token|password|passwd|secret|client_secret|api[_-]?key|apikey|authorization|session|sid|masq|st|ticket|signature|sig|code)(\\?["']?\s*[:=]\s*\\?["']?)(?!\[redacted\])[^\s"'&,;}\\]+/gi,
    `$1$2${REDACTED}`
  ]
]

/** One console line with secrets replaced by [redacted]. */
export function redactConsoleLine(line: string): string {
  let out = line
  for (const [re, to] of LINE_RULES) out = out.replace(re, to)
  return out
}

/** Elements whose content never goes into a bug-report screenshot. */
export const SCREENSHOT_BLOCK_SELECTOR = [
  '.nvr-no-record',
  '[data-replay-block]',
  '[data-nvr-recording-hide]',
  '[data-sensitive]'
].join(', ')

/** Inputs whose value is always masked in a bug-report screenshot. */
const SECRET_INPUT_SELECTOR = [
  'input[type="password"]',
  'input[autocomplete="one-time-code"]',
  'input[autocomplete="current-password"]',
  'input[autocomplete="new-password"]',
  'input[name*="token" i]',
  'input[name*="secret" i]',
  'input[name*="password" i]'
].join(', ')

/**
 * Mask a CLONED document before html2canvas draws it (its `onclone` hook):
 * never-record regions become blank blocks of the same size, secret inputs
 * show dots. The live page is not touched.
 */
export function maskScreenshotClone(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(SCREENSHOT_BLOCK_SELECTOR))) {
    // Emptied (a child styled visibility:visible would beat a hidden parent),
    // kept at its size so the layout around it still reads.
    const w = el.offsetWidth
    const h = el.offsetHeight
    el.replaceChildren()
    if ('value' in el) (el as HTMLInputElement).value = ''
    if (w && h) {
      el.style.setProperty('width', `${w}px`, 'important')
      el.style.setProperty('height', `${h}px`, 'important')
    }
    el.style.setProperty('background', '#cbd5e1', 'important')
  }
  for (const el of Array.from(doc.querySelectorAll<HTMLInputElement>(SECRET_INPUT_SELECTOR))) {
    if (el.value) el.value = '••••••••'
    el.setAttribute('value', el.value)
  }
}
