import { chatAvatarColor, chatAvatarColorAt, chatAvatarColorIndex } from '../chat-core'
import { type HuddleExtension, huddleStore } from './huddle-store'

/**
 * Point and draw on a shared screen (#2856). Viewers pick a pointer, pen or
 * arrow and mark up the screen someone shares; the marks show for everyone in
 * the huddle — the presenter on their own preview — and fade after four
 * seconds.
 *
 * Marks never reach the server: each peer connection carries one negotiated
 * RTCDataChannel (same id on both sides, created before the first offer), and
 * every message names the screen it belongs to by its owner's socket id, with
 * coordinates normalised to 0–1 over the shared picture so any size of view
 * lines up. Who drew is the channel's peer — never a field in the message.
 *
 * In a large huddle (#2859, LiveKit SFU) there is no mesh and the SFU token
 * cannot publish data, so the same messages ride the chat socket instead
 * (`huddle:mark`, api huddle-marks.ts): the server relays them to the others
 * in the roster, sets who drew from the sending socket, and stores nothing.
 * The message adds a colour index (a slot of the avatar palette); rendering
 * is the same.
 */

export const DRAW_CHANNEL_ID = 23
export const DRAW_CHANNEL_LABEL = 'nvr-huddle-draw'
/** A mark is gone this long after its last change; the last second fades it out. */
export const MARK_LIFE_MS = 4000
export const MARK_FADE_MS = 1000
const MAX_POINTS = 600
const MAX_MESSAGE = 16_000

export type DrawTool = 'pointer' | 'pen' | 'arrow'

export type DrawMsg =
  | { t: 'pt'; s: string; x: number; y: number }
  | { t: 'st'; s: string; id: string; tool: 'pen' | 'arrow'; k: number; p: number[] }
  | { t: 'clr'; s: string }

export interface Mark {
  /** `${from}:${id}` */
  key: string
  from: string
  tool: 'pen' | 'arrow'
  pts: Array<[number, number]>
  at: number
  color: string
  name: string
}

export interface Pointer {
  from: string
  x: number
  y: number
  at: number
  color: string
  name: string
}

const ID = /^[A-Za-z0-9_-]{1,64}$/

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Validate one channel message; anything off-shape is dropped (it came from another browser). */
export function parseDrawMsg(raw: unknown): DrawMsg | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return null
  try {
    return parseDrawObject(JSON.parse(raw))
  } catch {
    return null
  }
}

/** The same check on a decoded message (the socket path, #2859). Twin: api huddle-marks.ts. */
export function parseDrawObject(raw: unknown): DrawMsg | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (typeof m.s !== 'string' || !ID.test(m.s)) return null
  if (m.t === 'clr') return { t: 'clr', s: m.s }
  if (m.t === 'pt') {
    if (!finite(m.x) || !finite(m.y)) return null
    return { t: 'pt', s: m.s, x: clamp01(m.x), y: clamp01(m.y) }
  }
  if (m.t === 'st') {
    if (typeof m.id !== 'string' || !ID.test(m.id)) return null
    if (m.tool !== 'pen' && m.tool !== 'arrow') return null
    if (!finite(m.k) || m.k < 0 || m.k >= MAX_POINTS || !Number.isInteger(m.k)) return null
    if (!Array.isArray(m.p) || m.p.length % 2 || m.p.length > MAX_POINTS * 2) return null
    if (!m.p.every(finite)) return null
    return { t: 'st', s: m.s, id: m.id, tool: m.tool, k: m.k, p: (m.p as number[]).map(clamp01) }
  }
  return null
}

/** The marker colour for a person: the same hue as their chat avatar. */
export function drawColor(userId: string): string {
  return chatAvatarColor(userId)
}

/** Opacity of a mark `age` ms after its last change (1 → 0 over the last second). */
export function markOpacity(age: number): number {
  if (age <= MARK_LIFE_MS - MARK_FADE_MS) return 1
  if (age >= MARK_LIFE_MS) return 0
  return (MARK_LIFE_MS - age) / MARK_FADE_MS
}

/** Where the picture sits inside a <video> box (object-fit: contain letterboxes it). */
export function contentRect(
  boxW: number,
  boxH: number,
  videoW: number,
  videoH: number
): { x: number; y: number; w: number; h: number } {
  if (!videoW || !videoH || !boxW || !boxH) return { x: 0, y: 0, w: boxW, h: boxH }
  const scale = Math.min(boxW / videoW, boxH / videoH)
  const w = videoW * scale
  const h = videoH * scale
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h }
}

/** Points one socket message may carry (twin: api huddle-marks.ts MARK_MAX_POINTS). */
export const SOCKET_MAX_POINTS = 64
const SLOW_PAUSE_MS = 2000

/** A stroke longer than one socket message allows → several, same stroke id, offset `k`. */
export function splitForSocket(msg: DrawMsg): DrawMsg[] {
  if (msg.t !== 'st' || msg.p.length <= SOCKET_MAX_POINTS * 2) return [msg]
  const out: DrawMsg[] = []
  for (let i = 0; i < msg.p.length; i += SOCKET_MAX_POINTS * 2) {
    out.push({ ...msg, k: msg.k + i / 2, p: msg.p.slice(i, i + SOCKET_MAX_POINTS * 2) })
  }
  return out
}

type Listener = () => void

export interface DrawSnapshot {
  version: number
  /** Marks on each screen, by the screen owner's socket id. */
  marks: Map<string, Mark[]>
  pointers: Map<string, Map<string, Pointer>>
}

class DrawStore {
  private marks = new Map<string, Mark[]>()
  private pointers = new Map<string, Map<string, Pointer>>()
  private channels = new Map<string, RTCDataChannel>()
  private listeners = new Set<Listener>()
  private snap: DrawSnapshot = { version: 0, marks: this.marks, pointers: this.pointers }
  private seq = 0
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => this.snap
  private changed() {
    this.snap = { version: this.snap.version + 1, marks: this.marks, pointers: this.pointers }
    for (const l of this.listeners) l()
  }

  private who(from: string, colorIndex?: number): { name: string; color: string } {
    const s = huddleStore.getSnapshot()
    if (from === s.self) return { name: 'You', color: drawColor(this.myUser() || from) }
    const p = s.peers.find((x) => x.socket === from)
    const sent = colorIndex == null ? null : chatAvatarColorAt(colorIndex)
    return { name: p?.name || 'Someone', color: sent ?? drawColor(p?.user || from) }
  }
  /** My user id, for my own colour (the store only knows my socket). */
  selfUser = ''
  private myUser(): string {
    if (this.selfUser) return this.selfUser
    const s = huddleStore.getSnapshot()
    if (!s.room || !s.self) return ''
    return huddleStore.roster(s.room)?.find((p) => p.socket === s.self)?.user ?? ''
  }

  /** Apply one message from `from` (a peer's socket, or mine); `colorIndex` = the socket path's. */
  apply(from: string, msg: DrawMsg, now = Date.now(), colorIndex?: number) {
    if (msg.t === 'clr') {
      if (!this.marks.has(msg.s) && !this.pointers.has(msg.s)) return
      this.marks.delete(msg.s)
      this.pointers.delete(msg.s)
      return this.changed()
    }
    const { name, color } = this.who(from, colorIndex)
    if (msg.t === 'pt') {
      let on = this.pointers.get(msg.s)
      if (!on) {
        on = new Map()
        this.pointers.set(msg.s, on)
      }
      on.set(from, { from, x: msg.x, y: msg.y, at: now, color, name })
      return this.changed()
    }
    const key = `${from}:${msg.id}`
    const list = this.marks.get(msg.s) ?? []
    let mark = list.find((m) => m.key === key)
    if (!mark) {
      mark = { key, from, tool: msg.tool, pts: [], at: now, color, name }
      list.push(mark)
      this.marks.set(msg.s, list)
    }
    for (let i = 0; i < msg.p.length; i += 2) {
      const at = msg.k + i / 2
      if (at < MAX_POINTS) mark.pts[at] = [msg.p[i], msg.p[i + 1]]
    }
    // A dropped message leaves a hole; close it with the last known point.
    for (let i = 0; i < mark.pts.length; i++)
      if (!mark.pts[i]) mark.pts[i] = mark.pts[i - 1] ?? [0, 0]
    mark.at = now
    this.changed()
  }

  /** Forget everything older than MARK_LIFE_MS; true when anything is still showing. */
  prune(now = Date.now()): boolean {
    let dropped = false
    for (const [screen, list] of this.marks) {
      const keep = list.filter((m) => now - m.at < MARK_LIFE_MS)
      if (keep.length !== list.length) dropped = true
      if (keep.length) this.marks.set(screen, keep)
      else this.marks.delete(screen)
    }
    for (const [screen, on] of this.pointers) {
      for (const [from, p] of on) {
        if (now - p.at >= MARK_LIFE_MS) {
          on.delete(from)
          dropped = true
        }
      }
      if (!on.size) this.pointers.delete(screen)
    }
    if (dropped) this.changed()
    return this.marks.size > 0 || this.pointers.size > 0
  }

  /** People (not me) with a live mark or pointer on `screen`. */
  pointing(screen: string, now = Date.now()): number {
    const self = huddleStore.getSnapshot().self
    const who = new Set<string>()
    for (const m of this.marks.get(screen) ?? []) if (now - m.at < MARK_LIFE_MS) who.add(m.from)
    for (const p of this.pointers.get(screen)?.values() ?? []) {
      if (now - p.at < MARK_LIFE_MS) who.add(p.from)
    }
    if (self) who.delete(self)
    return who.size
  }

  /** Send to every peer and show it here at once. */
  send(msg: DrawMsg) {
    const snap = huddleStore.getSnapshot()
    const self = snap.self
    if (!self) return
    this.apply(self, msg)
    // #2859: on the SFU the marks ride the socket; the server relays them to the roster.
    if (snap.mode === 'sfu') {
      // The server told us to slow down: pointer moves are the ones to skip for a moment.
      if (msg.t === 'pt' && Date.now() < this.slowUntil) return
      const c = chatAvatarColorIndex(this.myUser() || self)
      for (const part of splitForSocket(msg)) huddleStore.send('huddle:mark', { ...part, c })
      return
    }
    const wire = JSON.stringify(msg)
    for (const ch of this.channels.values()) {
      if (ch.readyState !== 'open') continue
      try {
        ch.send(wire)
      } catch {
        /* a closing channel: the next message goes to the rest */
      }
    }
  }

  /** After a `huddle:mark:slow` from the server, pointer moves pause until then. */
  private slowUntil = 0

  nextStrokeId(): string {
    this.seq += 1
    return `${Date.now().toString(36)}${this.seq}`
  }

  /** A mark relayed over the socket (#2859): the server named the sender; the rest is checked. */
  private onSocketMark(p: Record<string, unknown> | null) {
    const s = huddleStore.getSnapshot()
    if (!p || s.status !== 'live' || p.room !== s.room) return
    const from = p.from
    if (typeof from !== 'string' || !ID.test(from) || from === s.self) return
    const msg = parseDrawObject(p)
    if (msg) this.apply(from, msg, Date.now(), typeof p.c === 'number' ? p.c : undefined)
  }

  /** People who left the roster take their marks with them (the SFU has no unlink). */
  private dropGone() {
    const s = huddleStore.getSnapshot()
    if (!s.room || s.mode !== 'sfu') return
    const here = new Set((huddleStore.roster(s.room) ?? []).map((p) => p.socket))
    if (!here.size) return
    const gone = new Set<string>()
    for (const [screen, list] of this.marks) {
      if (!here.has(screen)) gone.add(screen)
      for (const m of list) if (!here.has(m.from)) gone.add(m.from)
    }
    for (const [screen, on] of this.pointers) {
      if (!here.has(screen)) gone.add(screen)
      for (const from of on.keys()) if (!here.has(from)) gone.add(from)
    }
    for (const from of gone) this.dropFrom(from)
  }

  private dropFrom(from: string) {
    let changed = false
    for (const [screen, list] of this.marks) {
      const keep = list.filter((m) => m.from !== from)
      if (keep.length !== list.length) changed = true
      if (keep.length) this.marks.set(screen, keep)
      else this.marks.delete(screen)
    }
    // Their own screen's marks go with them.
    if (this.marks.delete(from) || this.pointers.delete(from)) changed = true
    for (const on of this.pointers.values()) if (on.delete(from)) changed = true
    if (changed) this.changed()
  }

  readonly ext: HuddleExtension = {
    attach: (transport) => [
      transport.on('huddle:mark', (p) => this.onSocketMark(p)),
      transport.on('huddle:mark:slow', (p: { room?: string } | null) => {
        if (p?.room === huddleStore.getSnapshot().room) this.slowUntil = Date.now() + SLOW_PAUSE_MS
      }),
      huddleStore.subscribeRosters(() => this.dropGone())
    ],
    link: (socket, pc) => {
      if (typeof pc.createDataChannel !== 'function') return
      let ch: RTCDataChannel
      try {
        ch = pc.createDataChannel(DRAW_CHANNEL_LABEL, {
          negotiated: true,
          id: DRAW_CHANNEL_ID,
          ordered: true,
          maxRetransmits: 2
        })
      } catch {
        return
      }
      this.channels.set(socket, ch)
      ch.onmessage = (e) => {
        const msg = parseDrawMsg(e.data)
        if (msg) this.apply(socket, msg)
      }
      ch.onclose = () => {
        if (this.channels.get(socket) === ch) this.channels.delete(socket)
      }
    },
    unlink: (socket) => {
      this.channels.delete(socket)
      this.dropFrom(socket)
    },
    teardown: () => {
      this.channels.clear()
      this.marks.clear()
      this.pointers.clear()
      this.changed()
    }
  }
}

export const drawStore = new DrawStore()

export function installHuddleDraw() {
  huddleStore.use(drawStore.ext)
}
