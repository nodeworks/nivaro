/**
 * "Is this tab in the middle of something live that a reload would cut off?" — a live huddle, a
 * screen clip being recorded. Not unsaved work (that is lib/unsaved-work.ts, the only source of
 * "unsaved changes"): nothing here is lost to a reload, it is interrupted. Read by the automatic
 * idle reload (lib/idle-reload.ts), which never reloads while any hold is on.
 *
 * Leaf module: the huddle store and the screen clip button report here, so the reload code never
 * imports the chat code.
 */

const holds = new Map<number, { label: string; active: () => boolean }>()
let seq = 0

/** Report something live; the returned function removes it. `active` is read at decision time. */
export function registerReloadHold(label: string, active: () => boolean = () => true): () => void {
  const id = ++seq
  holds.set(id, { label, active })
  return () => {
    holds.delete(id)
  }
}

/** What is live right now, by label (empty = nothing). */
export function reloadHoldLabels(): string[] {
  const out: string[] = []
  for (const h of holds.values()) {
    let on = false
    try {
      on = h.active()
    } catch {
      on = false
    }
    if (on && !out.includes(h.label)) out.push(h.label)
  }
  return out
}

/** Tests only. */
export function __resetReloadHoldsForTests(): void {
  holds.clear()
}
