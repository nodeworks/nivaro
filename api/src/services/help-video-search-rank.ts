import { sourceToEdited, type VideoEdits } from './help-video-edits.js'

// Ranking for Ask AI's search_help_videos tool (#1503). Pure: the caller hands
// in videos the asker may already watch (published, visibility checked) with
// their PUBLISHED version's edits; nothing here reads the database.
//
// A hit is one place the words were found: the title, a chapter name, a
// caption (and the one after it — speech is cut into short cues, a phrase
// often spans two) or the description. Ranking: hits holding every searched
// word come before partial ones; within each, title > chapter > caption >
// description. Times are EDITED time — what the viewer's progress bar shows
// (intro card included, cuts and speed applied), in whole seconds.

export type HitKind = 'title' | 'chapter' | 'caption' | 'description'
const TIER: Record<HitKind, number> = { title: 0, chapter: 1, caption: 2, description: 3 }

export interface SearchableVideo {
  id: string
  title: string
  description: string | null
  category: string | null
  /** The published version's edits; null = no chapters or captions to search. */
  edits: VideoEdits | null
}

export interface HelpVideoMoment {
  kind: HitKind
  /** The matched text, cut around the first matched word. */
  snippet: string
  /** Edited time in whole seconds. */
  t: number
  /** "0:42" */
  at: string
  chapter_id?: string
  /** Every searched word was found. */
  full: boolean
  coverage: number
}

export interface HelpVideoHit {
  id: string
  title: string
  category: string | null
  /** Where the best match was. */
  match: HitKind
  snippet: string
  t: number
  at: string
  chapter_id: string | null
  /** In-app path that opens the video at that moment. */
  path: string
  /** Ready markdown link for the answer. */
  cite: string
  /** Up to three chapter/caption moments, best first. */
  moments: HelpVideoMoment[]
}

const STOP = new Set(
  'a an and are as at be by can do does for from how i in into is it me my of on or so the then this to up use using what when where which who why with you your'.split(
    ' '
  )
)

function stem(w: string): string {
  let s = w.replace(/(ings|ing|ions|ion|ed|es|s)$/, '')
  // "submitting" → "submitt" → "submit"
  if (s !== w && /(ing|ed)$/.test(w)) s = s.replace(/([^aeiou])\1$/, '$1')
  // "approve" → "approv", so it finds "approving" and "approved" too.
  if (s.length > 4) s = s.replace(/e$/, '')
  return s.length >= 3 ? s : w
}

function words(text: string): string[] {
  return (
    String(text ?? '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

/** The words a query searches for: lower case, stop words dropped, stemmed,
 *  one each. Falls back to every word when the query is ALL stop words. */
export function searchTerms(query: string): string[] {
  // One-letter words are noise; a lone number ("Step 2") is not.
  const all = words(query).filter((w) => w.length >= 2 || /^\p{N}$/u.test(w))
  const kept = all.filter((w) => !STOP.has(w))
  return [...new Set((kept.length ? kept : all).map(stem))].slice(0, 12)
}

function coverage(text: string, terms: string[]): number {
  if (!terms.length) return 0
  const ws = words(text)
  let n = 0
  for (const t of terms) if (ws.some((w) => w.startsWith(t))) n++
  return n / terms.length
}

function clean(s: string): string {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Up to ~160 characters around the first matched word. */
export function excerpt(text: string, terms: string[], max = 160): string {
  const t = clean(text)
  if (t.length <= max) return t
  const lower = t.toLowerCase()
  let at = -1
  for (const term of terms) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u')
    const m = re.exec(lower)
    if (m && (at < 0 || m.index < at)) at = m.index + m[1].length
  }
  if (at < 0) at = 0
  let start = Math.max(0, at - 50)
  if (start > 0) {
    const sp = t.indexOf(' ', start)
    if (sp >= 0 && sp < at) start = sp + 1
  }
  let end = Math.min(t.length, start + max)
  if (end < t.length) {
    const sp = t.lastIndexOf(' ', end)
    if (sp > at) end = sp
  }
  return `${start > 0 ? '…' : ''}${t.slice(start, end)}${end < t.length ? '…' : ''}`
}

export function clockTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** Edited time of a source span's first kept moment (null = all cut). */
function keptStart(e: VideoEdits, start: number, end: number): number | null {
  const direct = sourceToEdited(e, start)
  if (direct !== null) return direct
  for (const s of e.segments) {
    if (s.end_ms > start && s.start_ms < end) return sourceToEdited(e, Math.max(start, s.start_ms))
  }
  return null
}

/** `/help-videos?watch=<id>&t=<s>[&c=<chapter>]` — the viewer's moment link. */
export function momentPath(videoId: string, t: number, chapterId?: string | null): string {
  const q = new URLSearchParams({ watch: videoId.toLowerCase(), t: String(Math.max(0, t)) })
  if (chapterId) q.set('c', chapterId)
  return `/help-videos?${q.toString()}`
}

/** A markdown link label cannot hold brackets or line breaks. */
function linkLabel(s: string): string {
  return clean(s).replace(/\[/g, '(').replace(/\]/g, ')').slice(0, 140)
}

interface RawHit {
  kind: HitKind
  text: string
  t: number
  chapter_id?: string
  coverage: number
}

function better(a: { coverage: number; kind: HitKind; t: number }, b: typeof a): number {
  const fa = a.coverage >= 1 ? 0 : 1
  const fb = b.coverage >= 1 ? 0 : 1
  return fa - fb || TIER[a.kind] - TIER[b.kind] || b.coverage - a.coverage || a.t - b.t
}

function hitsFor(v: SearchableVideo, terms: string[]): RawHit[] {
  const min = terms.length <= 1 ? 1 : 0.5
  const out: RawHit[] = []
  const push = (h: RawHit) => {
    if (h.coverage >= min) out.push(h)
  }
  push({ kind: 'title', text: v.title, t: 0, coverage: coverage(v.title, terms) })
  const e = v.edits
  if (e) {
    for (const c of e.chapters ?? []) {
      const at = sourceToEdited(e, c.at_ms)
      if (at === null) continue
      push({
        kind: 'chapter',
        text: c.title,
        t: Math.floor(at / 1000),
        chapter_id: c.id,
        coverage: coverage(c.title, terms)
      })
    }
    const caps = e.captions ?? []
    for (let i = 0; i < caps.length; i++) {
      const c = caps[i]
      const at = keptStart(e, c.start_ms, c.end_ms)
      if (at === null) continue
      const own = coverage(c.text, terms)
      const pair = caps[i + 1] ? `${c.text} ${caps[i + 1].text}` : c.text
      const paired = own >= 1 ? own : coverage(pair, terms)
      push({
        kind: 'caption',
        text: paired > own ? pair : c.text,
        t: Math.floor(at / 1000),
        coverage: paired
      })
    }
  }
  if (v.description)
    push({
      kind: 'description',
      text: v.description,
      t: 0,
      coverage: coverage(v.description, terms)
    })
  return out
}

/** Searches the given (already visible) videos. Best video first; at most
 *  `limit` (1–8, default 5). */
export function rankHelpVideoHits(
  videos: SearchableVideo[],
  query: string,
  limit = 5
): HelpVideoHit[] {
  const terms = searchTerms(query)
  if (!terms.length) return []
  const cap = Math.min(Math.max(Math.floor(limit) || 5, 1), 8)
  const ranked: Array<{ best: RawHit; hit: HelpVideoHit }> = []
  for (const v of videos) {
    const raw = hitsFor(v, terms)
    if (!raw.length) continue
    raw.sort(better)
    const best = raw[0]
    const seen = new Set<number>()
    const moments: HelpVideoMoment[] = []
    for (const h of raw) {
      if (h.kind !== 'chapter' && h.kind !== 'caption') continue
      if (seen.has(h.t)) continue
      seen.add(h.t)
      moments.push({
        kind: h.kind,
        snippet: excerpt(h.text, terms),
        t: h.t,
        at: clockTime(h.t),
        ...(h.chapter_id ? { chapter_id: h.chapter_id } : {}),
        full: h.coverage >= 1,
        coverage: Math.round(h.coverage * 100) / 100
      })
      if (moments.length >= 3) break
    }
    // The link opens the matching moment. A title or description match has
    // none of its own: it borrows the best moment when that moment holds
    // every word, else opens the video from the start.
    let t = best.t
    let chapter: string | null = best.chapter_id ?? null
    if ((best.kind === 'title' || best.kind === 'description') && moments[0]?.full) {
      t = moments[0].t
      chapter = moments[0].chapter_id ?? null
    }
    const title = linkLabel(v.title || 'Untitled video')
    const path = momentPath(v.id, t, chapter)
    ranked.push({
      best,
      hit: {
        id: v.id.toLowerCase(),
        title: v.title,
        category: v.category,
        match: best.kind,
        snippet: excerpt(best.text, terms),
        t,
        at: clockTime(t),
        chapter_id: chapter,
        path,
        cite: `[Watch ${t > 0 ? `${clockTime(t)} of ` : ''}${title}](${path})`,
        moments
      }
    })
  }
  ranked.sort((a, b) => better(a.best, b.best) || a.hit.title.localeCompare(b.hit.title))
  return ranked.slice(0, cap).map((r) => r.hit)
}
