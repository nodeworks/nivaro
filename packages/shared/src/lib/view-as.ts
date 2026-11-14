/**
 * "View as" registry (#640). A profile page offers "View as <person>" only
 * while the host app has said how it opens itself as someone else — the
 * admin opens a new tab on a per-tab masquerade token; a host without the
 * idea never registers and the button never shows. Same shape as the chat
 * DM opener registry.
 *
 * `path` (Rob 2026-11-13, "See this record as <person>"): the page the View-as
 * tab opens on — an app-relative path like `/collections/requests/42`. A host
 * that does not read it opens its home page, as before.
 */
export type ViewAsOpener = (person: {
  id: string
  name: string
  path?: string
}) => void | Promise<void>

let opener: ViewAsOpener | null = null

/** Register the host's opener. Returns an unregister function. */
export function registerViewAsOpener(fn: ViewAsOpener): () => void {
  opener = fn
  return () => {
    if (opener === fn) opener = null
  }
}

export function canViewAs(): boolean {
  return opener !== null
}

export function viewAs(person: { id: string; name: string; path?: string }): void | Promise<void> {
  return opener?.(person)
}

/**
 * The app-relative page a View-as tab may open on: a same-origin path only
 * (starts with one `/`, never `//host` or a scheme), else null. The page the
 * admin is on now when no path is given.
 */
export function viewAsPath(path?: string | null): string | null {
  const raw =
    path ??
    (typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : '')
  if (!raw?.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return null
  // Never carry a fragment (the token rides there) or a stray masquerade parameter.
  return raw.split('#')[0] ?? null
}
