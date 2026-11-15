import type { Editor } from '@tiptap/react'
import { noteCoeditLive, noteCoeditState } from '../../../lib/coedit-registry'
import {
  COEDIT_REMOTE,
  confirmedDoc,
  htmlOf,
  newClientId,
  type PMNode,
  type PMStep,
  type PMTransaction,
  type Rebaseable,
  rebaseable,
  receiveSteps,
  type SessionPayload,
  sessionDoc,
  stepFromJSON
} from './collab'
import { type CoeditCursor, setCoeditCursors } from './cursors'

/**
 * One editor's part in a field's writing session (realtime round 3, item 8).
 *
 * Lifecycle, as the person sees it:
 *   - The editor WATCHES its field as soon as it mounts (a gated room join; people who may not
 *     read the field are never let in). Nothing else happens while nobody writes.
 *   - A person who may write and puts the cursor in the field OPENS the session (the first one
 *     starts it from their document). From then on their typing goes out as steps.
 *   - Everyone else watching ADOPTS the session's document — unless they have unsaved edits of
 *     their own in that field that differ from it: those stay theirs, and the field falls back
 *     to the per-field merge at save (never overwritten).
 *   - A reader who may not write sees the text change; a writer also sees the others' cursors.
 *   - The form's value follows the shared document only for someone who has changed the field
 *     (their draft is the shared text); a person who only watched keeps a clean form.
 *   - The session ends when its last writer leaves (blur, closing the record); a watcher who never
 *     changed anything goes back to the record's saved value.
 *   - When the socket drops, the editor is a plain editor again: what the person typed stays
 *     in the form and saves the normal way (with the normal conflict check).
 */

export interface CoeditTransport {
  emit(event: string, payload: unknown): void
  on(event: string, cb: (payload: any) => void): () => void
}

export interface CoeditPeer {
  name: string
  color: string
}

export interface CoeditTarget {
  collection: string
  item: string
  field: string
}

export interface CoeditHost {
  /** The person has unsaved edits of this field (their form value differs from the saved one). */
  fieldDirty(): boolean
  /** The form's current value of the field (to go back to when a watched session ends). */
  formValue(): string
  /** Put a value back into the editor without telling the form (a watched session ended). */
  resetTo(value: string): void
  /** The person's own unsaved edits stay apart from a session others started (UI hint). */
  onDiverged?(diverged: boolean): void
  /** Who else is writing here (one entry per person), for the field's quiet "with Ana" mark. */
  onPeers?(peers: CoeditPeer[]): void
}

/** Cursor colours: six hues that carry white name text (≥4.5:1) and read on white and on
 *  slate-900 alike; never the brand cyan (that is the person's own focus ring). */
export const COEDIT_COLORS = ['#7c3aed', '#be185d', '#c2410c', '#047857', '#2563eb', '#a16207']

export function coeditColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0
  return COEDIT_COLORS[h % COEDIT_COLORS.length]
}

const SEND_RETRY_MS = 3_000
const CURSOR_EVERY_MS = 120
const HEARTBEAT_MS = 15_000
/** A watcher who never changed the field goes back to its saved value this long after the end
 *  (a save that ends the session usually lands first, so nothing flickers). */
const RESET_AFTER_END_MS = 2_500
const MAPS_KEPT = 300

interface Peer {
  clientID: string
  name: string
  color: string
  userId: string
  /** Position in this editor's current document. */
  anchor: number
  head: number
}

export class CoeditSession {
  readonly clientID = newClientId()
  private live = false
  private sid: string | null = null
  private version = 0
  private unconfirmed: Rebaseable[] = []
  private member = false
  private write = false
  private diverged = false
  private sentAt = 0
  private sentCount = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private resetTimer: ReturnType<typeof setTimeout> | null = null
  private closeWhenIdle = false
  /** Typed outside any session (and outside an open waiting for its answer): never replaced,
   *  even before the form has caught up with the keystrokes. */
  private typedApart = false
  private lastCursorAt = 0
  /** Opened while not live: the document the open was sent with, and steps typed since. */
  private pending: { doc: PMNode; steps: Rebaseable[] } | null = null
  /** The map of each version step (version → map), for cursors sent at an older version. */
  private maps = new Map<number, ReturnType<PMStep['getMap']>>()
  /** Cursors that arrived ahead of this editor's version. */
  private early: Array<{ p: any }> = []
  private peers = new Map<string, Peer>()
  private offs: Array<() => void> = []
  private disposed = false

  constructor(
    private editor: Editor,
    private target: CoeditTarget,
    private transport: CoeditTransport,
    private host: CoeditHost
  ) {}

  // ── Wiring ──────────────────────────────────────────────────────────────────

  start(): void {
    const t = this.transport
    const mine = (p: any) =>
      p &&
      p.collection === this.target.collection &&
      String(p.item) === this.target.item &&
      p.field === this.target.field
    const on = (event: string, fn: (p: any) => void) =>
      this.offs.push(t.on(event, (p) => !this.disposed && mine(p) && fn(p)))
    on('coedit:state', (p) => this.onState(p))
    on('coedit:active', (p) => this.onActive(p))
    on('coedit:steps', (p) => this.onSteps(p))
    on('coedit:cursor', (p) => this.onCursor(p))
    on('coedit:ended', () => this.onEnded())
    const ed = this.editor
    const onTr = ({ transaction }: { transaction: PMTransaction }) =>
      this.onTransaction(transaction)
    const onFocus = () => this.onFocus()
    const onBlur = () => this.onBlur()
    const onSel = () => this.scheduleCursor()
    ed.on('transaction', onTr)
    ed.on('focus', onFocus)
    ed.on('blur', onBlur)
    ed.on('selectionUpdate', onSel)
    this.offs.push(() => {
      ed.off('transaction', onTr)
      ed.off('focus', onFocus)
      ed.off('blur', onBlur)
      ed.off('selectionUpdate', onSel)
    })
    this.watch()
  }

  /** Join the field's rooms (again after a reconnect: a new socket holds no rooms). */
  watch(): void {
    this.transport.emit('coedit:watch', { ...this.target })
    if (this.editor.isFocused) this.onFocus()
  }

  /** The connection dropped: carry on as a plain editor (the form keeps what was typed). */
  disconnected(): void {
    if (this.live) this.leaveLive()
    this.member = false
    this.pending = null
  }

  dispose(): void {
    if (this.disposed) return
    if (this.member)
      this.transport.emit('coedit:close', { ...this.target, clientID: this.clientID })
    this.transport.emit('coedit:unwatch', { ...this.target })
    this.leaveLive()
    this.disposed = true
    for (const off of this.offs) off()
    this.offs = []
    for (const t of [this.retryTimer, this.cursorTimer, this.resetTimer]) if (t) clearTimeout(t)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
  }

  /** Is the form's value following the shared document (the person changed the field)? */
  tracking(): boolean {
    return this.live && this.host.fieldDirty()
  }

  isLive(): boolean {
    return this.live
  }

  // ── Server events ───────────────────────────────────────────────────────────

  private onState(p: { write?: boolean; session: SessionPayload | null }) {
    this.write = !!p.write
    if (!this.write && this.member) {
      // We may no longer type here (a lock, the record moved on, permission): a plain editor
      // again — what we typed stays in the form and meets the merge at save.
      this.member = false
      this.pending = null
      this.leaveLive()
    }
    if (!p.session) {
      // No session (or it lapsed while we thought we were in it).
      if (this.live) this.onEnded()
      if (this.editor.isFocused && this.write && !this.member) this.open()
      return
    }
    const same = this.live && p.session.sid === this.sid
    // Our session, at our version or older (a reply that crossed newer steps): nothing to do.
    if (same && p.session.version <= this.version) return
    if (same && p.session.version > this.version && p.session.baseVersion <= this.version) {
      // A catch-up (reconnect, second tab): the steps we missed are in the session.
      const from = this.version - p.session.baseVersion
      this.applyBatch(this.version, p.session.steps.slice(from))
      return
    }
    if (this.live) this.leaveLive()
    this.enter(p.session)
  }

  private onActive(p: { session: SessionPayload; by?: string }) {
    if (!p?.session) return
    if (this.live) {
      if (p.session.sid === this.sid) return
      // A new session while we still held an old one (its end never reached us).
      this.leaveLive()
    }
    this.enter(p.session)
  }

  private onSteps(p: { sid?: string; version: number; steps: unknown[]; clientIDs: string[] }) {
    if (!this.live || !Array.isArray(p.steps) || !Array.isArray(p.clientIDs)) return
    if (p.sid !== this.sid) return
    const v = Number(p.version)
    if (!Number.isInteger(v)) return
    if (v > this.version) {
      // A batch from further ahead (replicas can reorder): ask for what lies between.
      this.transport.emit('coedit:sync', { ...this.target, sid: this.sid, version: this.version })
      return
    }
    const skip = this.version - v
    if (skip >= p.steps.length) return
    this.applyBatch(
      this.version,
      p.steps.slice(skip).map((s, i) => ({ s, c: String(p.clientIDs[skip + i] ?? '') }))
    )
  }

  private applyBatch(version: number, entries: Array<{ s: unknown; c: string }>) {
    if (entries.length === 0) return
    const ed = this.editor
    let steps: PMStep[]
    try {
      steps = entries.map((e) => stepFromJSON(ed.state, e.s))
    } catch {
      this.resync()
      return
    }
    const hadOutstanding = this.sentCount > 0
    let r: ReturnType<typeof receiveSteps>
    try {
      r = receiveSteps(
        ed.state,
        this.unconfirmed,
        version,
        steps,
        entries.map((e) => e.c),
        this.clientID
      )
    } catch {
      this.resync()
      return
    }
    for (let i = 0; i < r.maps.length; i++) this.maps.set(version + i, r.maps[i])
    for (const k of this.maps.keys()) if (k < r.version - MAPS_KEPT) this.maps.delete(k)
    this.version = r.version
    this.unconfirmed = r.unconfirmed
    if (r.tr) ed.view.dispatch(r.tr)
    // Our batch is in (confirmed), or theirs got in first and ours was rebased: send what is left.
    if (hadOutstanding && (r.confirmed > 0 || r.tr)) this.sentCount = 0
    this.noteConfirmed()
    this.placeEarlyCursors()
    this.send()
    if (this.closeWhenIdle) this.maybeClose()
    if (r.confirmed > 0) this.scheduleCursor()
  }

  private onCursor(p: any) {
    if (!this.live || typeof p?.clientID !== 'string' || p.clientID === this.clientID) return
    if (p.clear) {
      if (this.peers.delete(p.clientID)) this.renderPeers()
      return
    }
    if (Number(p.version) > this.version) {
      this.early = [...this.early.filter((e) => e.p.clientID !== p.clientID), { p }].slice(-20)
      return
    }
    this.placeCursor(p)
  }

  private onEnded() {
    if (!this.live) return
    this.leaveLive()
    this.member = false
    // A watcher who never changed the field goes back to the saved value (a save usually
    // lands first, and then there is nothing to change).
    if (!this.host.fieldDirty()) {
      if (this.resetTimer) clearTimeout(this.resetTimer)
      this.resetTimer = setTimeout(() => {
        this.resetTimer = null
        if (this.disposed || this.live || this.host.fieldDirty()) return
        this.host.resetTo(this.host.formValue())
      }, RESET_AFTER_END_MS)
    }
    if (this.editor.isFocused && this.write) this.open()
  }

  // ── Entering and leaving ────────────────────────────────────────────────────

  private enter(session: SessionPayload) {
    const ed = this.editor
    let doc: PMNode
    try {
      doc = sessionDoc(ed.state, session)
    } catch {
      return
    }
    const mine = ed.state.doc
    let carry: Rebaseable[] = []
    if (this.pending?.doc.eq(doc)) {
      // We opened from this very document: what we typed since goes out on top of it.
      carry = this.pending.steps
    } else if (!mine.eq(doc)) {
      if (this.typedApart || this.host.fieldDirty()) {
        // Unsaved edits of our own that are not this document: they stay ours (merge at save).
        this.setDiverged(true)
        this.pending = null
        return
      }
      // Nothing of ours to keep: show the session's document (the form is not told).
      const tr = ed.state.tr.replaceWith(0, mine.content.size, doc.content)
      tr.setMeta(COEDIT_REMOTE, true)
      tr.setMeta('addToHistory', false)
      ed.view.dispatch(tr)
    }
    this.pending = null
    this.setDiverged(false)
    if (this.resetTimer) {
      clearTimeout(this.resetTimer)
      this.resetTimer = null
    }
    this.live = true
    this.sid = session.sid
    this.version = session.version
    this.unconfirmed = carry
    this.sentCount = 0
    this.maps.clear()
    noteCoeditLive(this.target.collection, this.target.item, this.target.field, true)
    this.noteConfirmed()
    if (this.editor.isFocused && this.write && !this.member) this.open()
    this.send()
  }

  private leaveLive() {
    if (!this.live) return
    this.live = false
    this.sid = null
    this.unconfirmed = []
    this.sentCount = 0
    this.closeWhenIdle = false
    this.early = []
    if (this.peers.size) {
      this.peers.clear()
      this.renderPeers()
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    noteCoeditLive(this.target.collection, this.target.item, this.target.field, false)
  }

  private resync() {
    // Something did not apply: start over from the server's copy.
    this.leaveLive()
    this.transport.emit('coedit:sync', { ...this.target })
  }

  private setDiverged(on: boolean) {
    if (this.diverged === on) return
    this.diverged = on
    this.host.onDiverged?.(on)
  }

  // ── Our side ────────────────────────────────────────────────────────────────

  private open() {
    if (!this.write || this.disposed) return
    this.member = true
    this.closeWhenIdle = false
    if (!this.live) this.pending = { doc: this.editor.state.doc, steps: [] }
    this.transport.emit('coedit:open', {
      ...this.target,
      clientID: this.clientID,
      doc: this.editor.state.doc.toJSON()
    })
    if (!this.heartbeatTimer)
      this.heartbeatTimer = setInterval(() => this.sendCursor(true), HEARTBEAT_MS)
  }

  private onFocus() {
    if (this.write && !this.member && this.editor.isEditable) this.open()
    else this.scheduleCursor()
  }

  private onBlur() {
    if (!this.member) return
    this.transport.emit('coedit:cursor', { ...this.target, clientID: this.clientID, clear: true })
    this.closeWhenIdle = true
    this.maybeClose()
  }

  /** Leave the session once everything we typed is in (never with steps still unsent). */
  private maybeClose() {
    if (!this.member || this.editor.isFocused) {
      this.closeWhenIdle = false
      return
    }
    if (this.live && this.unconfirmed.length > 0) return
    this.closeWhenIdle = false
    this.member = false
    this.pending = null
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.transport.emit('coedit:close', { ...this.target, clientID: this.clientID })
  }

  private onTransaction(tr: PMTransaction) {
    if (!tr.docChanged) return
    // Others' cursors move with every change (the cursor marks map theirs the same way).
    for (const p of this.peers.values()) {
      p.anchor = tr.mapping.map(p.anchor, -1)
      p.head = tr.mapping.map(p.head, 1)
    }
    if (tr.getMeta(COEDIT_REMOTE)) return
    // The person's own change (typing, a toolbar command, Take theirs…).
    if (this.live) {
      for (let i = 0; i < tr.steps.length; i++)
        this.unconfirmed.push(rebaseable(tr.steps[i], tr.docs[i]))
      this.send()
    } else if (this.pending) {
      for (let i = 0; i < tr.steps.length; i++)
        this.pending.steps.push(rebaseable(tr.steps[i], tr.docs[i]))
    } else if (!tr.getMeta('preventUpdate')) {
      // (A value put in by the form itself — setContent without an update — is not typing.)
      this.typedApart = true
    }
  }

  /** Send the unconfirmed steps (one batch in flight at a time). */
  private send() {
    if (!this.live || !this.member || this.unconfirmed.length === 0) return
    const now = Date.now()
    if (this.sentCount > 0 && now - this.sentAt < SEND_RETRY_MS) {
      this.armRetry()
      return
    }
    const steps = this.unconfirmed.slice(0, 200)
    this.sentCount = steps.length
    this.sentAt = now
    this.transport.emit('coedit:steps', {
      ...this.target,
      clientID: this.clientID,
      sid: this.sid,
      version: this.version,
      steps: steps.map((s) => s.step.toJSON())
    })
    this.armRetry()
  }

  private armRetry() {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.sentCount > 0 && Date.now() - this.sentAt >= SEND_RETRY_MS) this.sentCount = 0
      this.send()
    }, SEND_RETRY_MS)
  }

  private scheduleCursor() {
    if (!this.live || !this.member || !this.editor.isFocused) return
    if (this.cursorTimer) return
    const wait = Math.max(0, CURSOR_EVERY_MS - (Date.now() - this.lastCursorAt))
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null
      this.sendCursor(false)
    }, wait)
  }

  /** Our selection, at the confirmed version (others can place it); also the heartbeat. */
  private sendCursor(heartbeat: boolean) {
    if (!this.live || !this.member || this.disposed) return
    if (!this.editor.isFocused) {
      if (heartbeat)
        this.transport.emit('coedit:cursor', {
          ...this.target,
          clientID: this.clientID,
          clear: true
        })
      return
    }
    // Positions are only meaningful to others once our own steps are in.
    if (this.unconfirmed.length > 0) return
    const { anchor, head } = this.editor.state.selection
    this.lastCursorAt = Date.now()
    this.transport.emit('coedit:cursor', {
      ...this.target,
      clientID: this.clientID,
      version: this.version,
      anchor,
      head
    })
  }

  // ── Cursors of others ──────────────────────────────────────────────────────

  private placeCursor(p: any) {
    let anchor = Number(p.anchor)
    let head = Number(p.head)
    // From the version they were sent at up to ours, then over our own unconfirmed steps.
    for (let v = Number(p.version); v < this.version; v++) {
      const m = this.maps.get(v)
      if (!m) return
      anchor = m.map(anchor, -1)
      head = m.map(head, 1)
    }
    for (const u of this.unconfirmed) {
      const m = u.step.getMap()
      anchor = m.map(anchor, -1)
      head = m.map(head, 1)
    }
    const size = this.editor.state.doc.content.size
    const clamp = (n: number) => Math.max(0, Math.min(size, n))
    const userId = String(p.user?.id ?? '')
    this.peers.set(p.clientID, {
      clientID: p.clientID,
      name: String(p.user?.name ?? 'Someone').slice(0, 80),
      color: coeditColor(userId || p.clientID),
      userId,
      anchor: clamp(anchor),
      head: clamp(head)
    })
    this.renderPeers(p.clientID)
  }

  private placeEarlyCursors() {
    if (this.early.length === 0) return
    const ready = this.early.filter((e) => Number(e.p.version) <= this.version)
    this.early = this.early.filter((e) => Number(e.p.version) > this.version)
    for (const e of ready) this.placeCursor(e.p)
  }

  private renderPeers(wake?: string) {
    const list: CoeditCursor[] = [...this.peers.values()].map((p) => ({
      id: p.clientID,
      name: p.name,
      color: p.color,
      anchor: p.anchor,
      head: p.head
    }))
    setCoeditCursors(this.editor, list, wake)
    const people = new Map<string, CoeditPeer>()
    for (const p of this.peers.values())
      if (!people.has(p.userId || p.name))
        people.set(p.userId || p.name, { name: p.name, color: p.color })
    this.host.onPeers?.([...people.values()])
  }

  /** Remember the confirmed document state (a save of it is no conflict, coedit-registry). */
  private noteConfirmed() {
    if (!this.live) return
    try {
      const doc = confirmedDoc(this.editor.state, this.unconfirmed)
      noteCoeditState(
        this.target.collection,
        this.target.item,
        this.target.field,
        htmlOf(doc, this.editor.schema)
      )
    } catch {
      /* the registry is a courtesy; the merge path still guards the save */
    }
  }
}
