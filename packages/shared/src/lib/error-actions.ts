import { type ErrorActionKind, type ErrorDescription, errorDetailsText } from './error-message'

/**
 * The one button an error offers, made to do the thing it says:
 *
 *   retry     the caller's retry (refetch, send again); without one, a reload
 *   reload    reload the page (someone else's changes, maintenance over)
 *   sign-in   the app's sign-in page, coming back here afterwards
 *   go-back   one step back in the app's history, else home
 *   contact   the Support page in a new tab, a new request already filled in
 *             with what happened and the reference — the work on this page
 *             stays where it is
 *
 * Hosts may point these elsewhere with `setErrorActionHost` (an SPA navigate,
 * another sign-in path); the defaults work in any app that serves /login and
 * /support.
 */
export interface ErrorActionHost {
  /** In-app navigation; window.location otherwise. */
  navigate?: (path: string) => void
  /** Default '/login' (the page reads ?redirect=). */
  signInPath?: string
  /** Default '/support' (the shared SupportView picks up the prepared request). */
  supportPath?: string
  /** Replaces the sign-in default entirely. */
  signIn?: () => void
}

let host: ErrorActionHost = {}

export function setErrorActionHost(next: ErrorActionHost): void {
  host = { ...host, ...next }
}

const SUPPORT_DRAFT_KEY = 'nvr:support-draft'
const SUPPORT_DRAFT_MAX_AGE_MS = 15 * 60_000

export interface SupportDraft {
  title: string
  description: string
}

/** The request the Support page opens with, stored for the new tab (localStorage, 15 minutes). */
export function saveSupportDraft(draft: SupportDraft, now = Date.now()): void {
  try {
    localStorage.setItem(SUPPORT_DRAFT_KEY, JSON.stringify({ ...draft, at: now }))
  } catch {
    /* storage refused: the Support page opens empty */
  }
}

/** The prepared request, once (it is removed when read); null when none or stale. */
export function takeSupportDraft(now = Date.now()): SupportDraft | null {
  try {
    const raw = localStorage.getItem(SUPPORT_DRAFT_KEY)
    if (!raw) return null
    localStorage.removeItem(SUPPORT_DRAFT_KEY)
    const d = JSON.parse(raw) as Partial<SupportDraft> & { at?: number }
    if (typeof d.at !== 'number' || now - d.at > SUPPORT_DRAFT_MAX_AGE_MS) return null
    if (typeof d.title !== 'string' || typeof d.description !== 'string') return null
    return { title: d.title.slice(0, 200), description: d.description.slice(0, 4000) }
  } catch {
    return null
  }
}

/** The request a "Get help" / "Ask for access" button prepares. */
export function supportDraftFor(
  d: ErrorDescription,
  extra: { action?: string } = {}
): SupportDraft {
  const lead =
    d.kind === 'forbidden'
      ? 'I need access to do this.'
      : 'I ran into a problem and could not finish what I was doing.'
  return {
    title: (d.kind === 'forbidden' ? `Access: ${d.title}` : d.title).slice(0, 200),
    description: `${lead}\n\n${errorDetailsText(d, extra)}`
  }
}

function go(path: string): void {
  if (host.navigate) host.navigate(path)
  else if (typeof window !== 'undefined') window.location.assign(path)
}

/** Open Support with the request filled in, in a new tab; this page keeps its work. */
export function openSupportForError(d: ErrorDescription, extra: { action?: string } = {}): void {
  saveSupportDraft(supportDraftFor(d, extra))
  const url = `${host.supportPath ?? '/support'}?new=1`
  if (typeof window === 'undefined') return
  const w = window.open(url, '_blank')
  if (w) w.opener = null
  else go(url)
}

export function goToSignIn(): void {
  if (host.signIn) {
    host.signIn()
    return
  }
  if (typeof window === 'undefined') return
  const here = `${window.location.pathname}${window.location.search}`
  const path = host.signInPath ?? '/login'
  window.location.assign(
    here && !here.startsWith(path) ? `${path}?redirect=${encodeURIComponent(here)}` : path
  )
}

export function goBack(): void {
  if (typeof window === 'undefined') return
  if (window.history.length > 1) window.history.back()
  else go('/')
}

/** Run the action an error offers. `retry` is the caller's own (refetch, send again). */
export function runErrorAction(
  kind: ErrorActionKind,
  d: ErrorDescription,
  opts: { retry?: () => void; action?: string } = {}
): void {
  switch (kind) {
    case 'retry':
      if (opts.retry) opts.retry()
      else if (typeof window !== 'undefined') window.location.reload()
      return
    case 'reload':
      if (typeof window !== 'undefined') window.location.reload()
      return
    case 'sign-in':
      goToSignIn()
      return
    case 'go-back':
      goBack()
      return
    case 'contact':
      openSupportForError(d, { action: opts.action })
      return
  }
}
