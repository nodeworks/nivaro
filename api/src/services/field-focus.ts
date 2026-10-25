/**
 * The fields one socket said it is in, per record room ("X is editing this
 * field" on co-viewers' forms). A page that navigates away or a dropped
 * connection never sends field:blur, so the mark stuck on everyone else's
 * form for someone long gone. The socket handler releases a room's marks on
 * leave and disconnect; a mark with no focus or keystroke for `ttlMs` lapses
 * on its own (`onLapse` tells the room).
 */
export function fieldFocusTracker(opts: {
  ttlMs: number
  /** Marks one socket may hold at once (a field, its grid row and cell). */
  max: number
  onLapse: (room: string, field: string) => void
}) {
  const held = new Map<
    string,
    { room: string; field: string; timer: ReturnType<typeof setTimeout> }
  >()
  const keyOf = (room: string, field: string) => `${room}\u0000${field}`

  const release = (room: string, field: string): boolean => {
    const key = keyOf(room, field)
    const mark = held.get(key)
    if (!mark) return false
    clearTimeout(mark.timer)
    held.delete(key)
    return true
  }

  return {
    /** Focus in a field (again): start or restart its clock. */
    hold(room: string, field: string) {
      const key = keyOf(room, field)
      const had = held.get(key)
      if (had) clearTimeout(had.timer)
      else if (held.size >= opts.max) return
      const timer = setTimeout(() => {
        if (release(room, field)) opts.onLapse(room, field)
      }, opts.ttlMs)
      held.set(key, { room, field, timer })
    },
    /** A keystroke in a held field keeps it alive; an unheld one starts nothing. */
    touch(room: string, field: string) {
      if (held.has(keyOf(room, field))) this.hold(room, field)
    },
    /** Blur: true when the field was held. */
    release,
    /** Leaving the room (or disconnecting): the fields to announce as left. */
    releaseRoom(room: string): string[] {
      const out: string[] = []
      for (const mark of [...held.values()])
        if (mark.room === room && release(room, mark.field)) out.push(mark.field)
      return out
    },
    size: () => held.size
  }
}
