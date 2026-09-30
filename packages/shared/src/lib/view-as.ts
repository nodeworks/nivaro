/**
 * "View as" registry (#640). A profile page offers "View as <person>" only
 * while the host app has said how it opens itself as someone else — the
 * admin opens a new tab on a per-tab masquerade token; a host without the
 * idea never registers and the button never shows. Same shape as the chat
 * DM opener registry.
 */
export type ViewAsOpener = (person: { id: string; name: string }) => void | Promise<void>

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

export function viewAs(person: { id: string; name: string }): void | Promise<void> {
  return opener?.(person)
}
