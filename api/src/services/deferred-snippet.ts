/**
 * What a mail held for the daily action summary keeps about itself (nivaro_deferred_emails.snippet):
 * a one-line summary and the record it is about, so the summary can show
 * "CR26-81427 is now Waiting on Level 5 Approval — From Level 4 to Level 5. It is now waiting on …"
 * with a link, instead of the first 120 characters of the rendered page (title tag, hidden
 * preheader and the brand header three times — army 11).
 *
 * Stored as JSON `{"t": text, "c": collection, "i": item}` in the existing snippet column (no
 * migration); rows written before this are plain text and are read as such.
 */

const MAX_TEXT = 300

const decode = (s: string) =>
  s
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&middot;/gi, '·')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')

const toText = (html: string) =>
  decode(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      // inline tags join their words; block tags separate them
      .replace(/<\/?(strong|b|em|i|span|a|u|small|code)\b[^>]*>/gi, '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()

/** Pure: the useful sentence(s) of a rendered mail — never the head, preheader, brand or buttons. */
export function mailSummaryText(htmlOrText: string): string {
  let s = String(htmlOrText ?? '')
  if (!/<[a-z][\s\S]*>/i.test(s)) return s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  s = s
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(style|script|title)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // the hidden preheader and anything else not shown
    .replace(/<(div|span|p)\b[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  // The branded chrome: keep only the card body when the template marks it.
  const body = s.search(/id=["']card-body["']/i)
  if (body >= 0) {
    s = s.slice(body)
    const ftr = s.search(/id=["']card-ftr["']/i)
    if (ftr > 0) s = s.slice(0, ftr)
  }
  // The headline repeats the subject; buttons are not sentences.
  s = s
    .replace(/<h1\b[\s\S]*?<\/h1>/gi, ' ')
    .replace(/<a\b[^>]*display\s*:\s*inline-block[^>]*>[\s\S]*?<\/a>/gi, ' ')
  const paras = [...s.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => toText(m[1]))
    .filter(
      (t) =>
        t.length > 0 &&
        // an eyebrow ("SUBMIT", "Approve") is not a summary
        !(t.length <= 24 && !/[.:!?]/.test(t) && t.split(' ').length <= 3) &&
        !/^triggered by\b/i.test(t)
    )
  const picked = paras.length > 0 ? paras.slice(0, 2).join(' ') : toText(s)
  if (picked.length <= MAX_TEXT) return picked
  const cut = picked.slice(0, MAX_TEXT)
  const space = cut.lastIndexOf(' ')
  return `${space > MAX_TEXT * 0.6 ? cut.slice(0, space) : cut}…`
}

export interface DeferredSnippet {
  text: string
  collection: string | null
  item: string | null
}

export function encodeDeferredSnippet(
  htmlOrText: string,
  record?: { collection?: string | null; item?: string | number | null }
): string {
  const t = mailSummaryText(htmlOrText)
  const c = record?.collection ? String(record.collection) : null
  const i = record?.item != null && String(record.item) !== '' ? String(record.item) : null
  return JSON.stringify({ t, c, i }).slice(0, 2000)
}

export function decodeDeferredSnippet(raw: string | null | undefined): DeferredSnippet {
  const s = String(raw ?? '')
  if (s.startsWith('{"t":')) {
    try {
      const j = JSON.parse(s) as { t?: unknown; c?: unknown; i?: unknown }
      return {
        text: String(j.t ?? ''),
        collection: j.c ? String(j.c) : null,
        item: j.i != null && j.i !== '' ? String(j.i) : null
      }
    } catch {
      // fall through: an old plain row
    }
  }
  // A row from before: the stripped page. Its start is boilerplate, so show nothing rather
  // than "Engineering Finance Portal Engineering Finance Portal …".
  return { text: '', collection: null, item: null }
}
