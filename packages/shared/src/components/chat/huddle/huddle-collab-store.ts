/**
 * Working together in a huddle — the browser side (#2854 #2855). Two small
 * module stores that ride the huddle's socket (the host's RealtimeAdapter,
 * reached through huddleStore) and follow its life: joining a huddle syncs
 * them, leaving resets them.
 *
 * Notes: one shared hand-written note. Typing is debounced 500 ms, then sent
 * whole; the server hands back a rising rev, last writer wins. A copy from
 * someone else replaces mine unless I have an edit waiting — mine goes out
 * next and wins.
 *
 * Follow me: in a record room's huddle one person presents; everyone else's
 * page follows the presenter's tab and section. A follower navigates through
 * the host's own navigation (registered by HuddleFollowHost), with their own
 * permissions — never window.location. Any navigation of their own, or a tab
 * they pick themselves, stops following.
 */
import {
  applyFollowStep,
  currentRecordView,
  currentSection,
  onManualRecordChange,
  sameRecord,
  scrollToSection,
  subscribeRecordView
} from './huddle-follow-bus'
import { type HuddleState, type HuddleTransport, huddleStore } from './huddle-store'

/** Matches the server's cap (huddle-collab.ts NOTE_MAX_BYTES). */
export const NOTE_MAX_BYTES = 20 * 1024
export const NOTE_DEBOUNCE_MS = 500
/** Presenter moves go out at most 4 a second (the server drops more). */
export const FOLLOW_THROTTLE_MS = 250
/** After the follow store navigates, the page has this long to show the record. */
const NAV_SETTLE_MS = 8_000
const PATH_POLL_MS = 1_000

export function noteBytes(text: string): number {
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length
}

type Listener = () => void

class Emitter<S> {
  protected state: S
  private listeners = new Set<Listener>()
  constructor(initial: S) {
    this.state = initial
  }
  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => this.state
  protected set(patch: Partial<S>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }
}

// ── Notes (#2854) ───────────────────────────────────────────────────────────

export interface NoteState {
  room: string | null
  text: string
  rev: number
  /** Who wrote the copy I am looking at (null = me, or nobody yet). */
  lastBy: { id: string | null; name: string | null } | null
  lastAt: number | null
  /** An edit of mine is waiting for the debounce. */
  pending: boolean
  error: string | null
  /** The notes panel is open (per huddle, so a long call keeps it where it was). */
  open: boolean
  /** Someone else changed the note while the panel was closed. */
  unseen: boolean
}

const NOTE_IDLE: NoteState = {
  room: null,
  text: '',
  rev: 0,
  lastBy: null,
  lastAt: null,
  pending: false,
  error: null,
  open: false,
  unseen: false
}

interface NoteIn {
  room: string
  text: string
  rev: number
  by: { id: string | null; name: string | null } | null
  from: string | null
}

export class HuddleNoteStore extends Emitter<NoteState> {
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly t: () => HuddleTransport | null,
    private readonly self: () => string | null
  ) {
    super(NOTE_IDLE)
  }

  /** The huddle I am in changed (join, leave, a new room). */
  reset(room: string | null) {
    if (this.state.room === room) return
    this.cancel()
    // The huddle I just left: its note stays at hand in case the room refuses to post it.
    if (this.state.room && this.state.text.trim()) {
      this.ended = { room: this.state.room, text: this.state.text }
    }
    this.set({ ...NOTE_IDLE, room })
  }

  /** The last note of a huddle I left (null when there was none). */
  private ended: { room: string; text: string } | null = null
  private unpostedListeners = new Set<(p: { room: string; reason: string }) => void>()

  endedNote(room: string): string | null {
    return this.ended?.room === room ? this.ended.text : null
  }

  /** The end could not post the notes (the room refused their writer): tell the UI. */
  onUnpostedNote(cb: (p: { room: string; reason: string }) => void) {
    this.unpostedListeners.add(cb)
    return () => {
      this.unpostedListeners.delete(cb)
    }
  }

  onUnposted(p: { room: string; reason: string }) {
    if (!p?.room) return
    // No copy here (another tab wrote it): the server keeps it for the attendees a while.
    if (!this.endedNote(p.room)) this.t()?.emit('huddle:note:fetch', { room: p.room })
    for (const l of this.unpostedListeners) l(p)
  }

  onKept(p: { room: string; text: string }) {
    if (p?.room && typeof p.text === 'string') this.ended = { room: p.room, text: p.text }
  }

  setOpen(open: boolean) {
    this.set({ open, unseen: open ? false : this.state.unseen })
  }

  setText(text: string) {
    if (!this.state.room) return
    const tooLong = noteBytes(text) > NOTE_MAX_BYTES
    this.set({
      text,
      pending: !tooLong,
      lastBy: null,
      lastAt: Date.now(),
      error: tooLong ? 'Notes hold up to 20 KB — shorten them to keep syncing.' : null
    })
    this.cancel()
    if (!tooLong) this.timer = setTimeout(() => this.flush(), NOTE_DEBOUNCE_MS)
  }

  /** Send a waiting edit now (Leave, or the debounce firing). */
  flush() {
    this.cancel()
    const { room, text, rev, pending } = this.state
    if (!room || !pending) return
    this.t()?.emit('huddle:note', { room, text, rev })
    this.set({ pending: false })
  }

  private cancel() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  onNote(p: NoteIn) {
    if (!p || p.room !== this.state.room || !(p.rev > this.state.rev)) return
    const mine = !!p.from && p.from === this.self()
    // My own echo, or someone else's copy while I have an edit waiting: keep my text (it
    // goes out next and wins); only the rev moves on.
    if (mine || this.state.pending) {
      this.set({ rev: p.rev })
      return
    }
    this.set({
      text: p.text,
      rev: p.rev,
      lastBy: p.by,
      lastAt: Date.now(),
      error: null,
      unseen: !this.state.open && p.text !== this.state.text
    })
  }

  onDenied(p: { room: string; reason: string; rev?: number }) {
    if (!p || p.room !== this.state.room) return
    if (p.reason === 'bad-rev') {
      // The server's rev is the only one: take it and send my text again on top of it.
      if (Number.isSafeInteger(p.rev)) this.set({ rev: p.rev as number, pending: true })
      this.cancel()
      this.timer = setTimeout(() => this.flush(), NOTE_DEBOUNCE_MS)
    } else if (p.reason === 'rate') {
      // Too many edits at once: try again in a moment with whatever is newest.
      this.set({ pending: true })
      this.cancel()
      this.timer = setTimeout(() => this.flush(), 1_000)
    } else if (p.reason === 'too-long') {
      this.set({ pending: false, error: 'Notes hold up to 20 KB — shorten them to keep syncing.' })
    }
  }
}

// ── Follow me (#2855) ───────────────────────────────────────────────────────

export interface FollowPerson {
  socket: string
  user: string
  name: string | null
}

export interface FollowState {
  room: string | null
  /** Who presents right now (me included). */
  presenter: FollowPerson | null
  /** The record being presented (named by the server from the room). */
  target: { collection: string; id: string; step: string | null; section: string | null } | null
  presenting: boolean
  following: boolean
  /** Someone asked me to hand over. */
  request: FollowPerson | null
  /** My own ask to take over: waiting, or the presenter said no. */
  asked: 'pending' | 'declined' | null
  error: string | null
}

const FOLLOW_IDLE: FollowState = {
  room: null,
  presenter: null,
  target: null,
  presenting: false,
  following: false,
  request: null,
  asked: null,
  error: null
}

interface FollowIn {
  room: string
  action: 'start' | 'move' | 'state' | 'stop' | 'request' | 'granted' | 'declined'
  presenter?: FollowPerson
  collection?: string
  id?: string
  step?: string | null
  section?: string | null
  from?: FollowPerson
}

export interface FollowNavigator {
  navigate(path: string): void
  urlFor(target: {
    collection: string
    itemId: string
    query?: Record<string, string> | null
  }): string
}

export class HuddleFollowStore extends Emitter<FollowState> {
  private nav: FollowNavigator | null = null
  /** Where the last navigation I made went, and until when its page may still be loading. */
  private navigated: { key: string; until: number } | null = null
  private settledPath: string | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private moveTimer: ReturnType<typeof setTimeout> | null = null
  private lastSent = 0
  private lastPos: { step: string | null; section: string | null } | null = null
  private offBus: Array<() => void> = []
  private onScroll = () => this.queueMove()
  private askTimer: ReturnType<typeof setTimeout> | null = null
  /** The tab + section my page was last brought to (a repeat move does not re-scroll). */
  private applied: string | null = null

  constructor(
    private readonly t: () => HuddleTransport | null,
    private readonly self: () => string | null,
    private readonly path: () => string = () =>
      typeof window === 'undefined' ? '' : window.location.pathname
  ) {
    super(FOLLOW_IDLE)
    this.offBus = [
      subscribeRecordView(() => this.onView()),
      onManualRecordChange(() => {
        if (this.state.following) this.stopFollowing()
      })
    ]
  }

  setNavigator(nav: FollowNavigator | null) {
    this.nav = nav
  }

  reset(room: string | null) {
    if (this.state.room === room) return
    this.endPresenting()
    this.stopPolling()
    this.navigated = null
    this.applied = null
    if (this.askTimer) clearTimeout(this.askTimer)
    this.askTimer = null
    this.set({ ...FOLLOW_IDLE, room })
  }

  // ── Presenter ─────────────────────────────────────────────────────────────
  /** Present, or — while someone else does — ask them to hand over. */
  start(record?: { collection: string; id: string } | null) {
    const room = this.state.room
    if (!room) return
    const other = this.state.presenter && this.state.presenter.socket !== this.self()
    if (other) {
      this.t()?.emit('huddle:follow', { room, action: 'request' })
      this.setAsked('pending')
      return
    }
    // Not on the record's page yet: go there first, so followers land where I am.
    const view = currentRecordView()
    if (record && !sameRecord(view, record) && this.nav) {
      this.nav.navigate(this.nav.urlFor({ collection: record.collection, itemId: record.id }))
    }
    const pos = this.position(record ?? null)
    this.lastPos = pos
    this.lastSent = Date.now()
    this.t()?.emit('huddle:follow', { room, action: 'start', ...pos })
  }

  stopPresenting() {
    const room = this.state.room
    if (!room || !this.state.presenting) return
    this.t()?.emit('huddle:follow', { room, action: 'stop' })
  }

  handOver(to: string) {
    if (this.state.room)
      this.t()?.emit('huddle:follow', { room: this.state.room, action: 'handover', to })
    this.set({ request: null })
  }

  decline(to: string) {
    if (this.state.room)
      this.t()?.emit('huddle:follow', { room: this.state.room, action: 'decline', to })
    this.set({ request: null })
  }

  private position(record: { collection: string; id: string } | null) {
    const view = currentRecordView()
    const target = record ?? this.state.target
    const onIt = view && (!target || sameRecord(view, target))
    return {
      step: onIt ? view.step : null,
      section: onIt && typeof document !== 'undefined' ? currentSection() : null
    }
  }

  private beginPresenting() {
    if (typeof document !== 'undefined' && !this.state.presenting) {
      document.addEventListener('scroll', this.onScroll, { capture: true, passive: true })
    }
  }

  private endPresenting() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('scroll', this.onScroll, { capture: true })
    }
    if (this.moveTimer) clearTimeout(this.moveTimer)
    this.moveTimer = null
  }

  /** Throttled with a trailing send, so where I stop is where followers end up. */
  private queueMove() {
    if (!this.state.presenting || this.moveTimer) return
    const wait = Math.max(0, FOLLOW_THROTTLE_MS - (Date.now() - this.lastSent))
    this.moveTimer = setTimeout(() => {
      this.moveTimer = null
      this.sendMove()
    }, wait)
  }

  private sendMove() {
    const room = this.state.room
    if (!room || !this.state.presenting || !this.state.target) return
    const view = currentRecordView()
    // Off the record (another page): followers stay where they are.
    if (!sameRecord(view, this.state.target)) return
    const pos = this.position(null)
    if (this.lastPos && pos.step === this.lastPos.step && pos.section === this.lastPos.section)
      return
    this.lastPos = pos
    this.lastSent = Date.now()
    this.t()?.emit('huddle:follow', { room, action: 'move', ...pos })
  }

  // ── Follower ──────────────────────────────────────────────────────────────
  stopFollowing() {
    this.stopPolling()
    this.navigated = null
    this.applied = null
    this.set({ following: false })
  }

  /** Follow the presenter again after stopping. */
  resume() {
    if (!this.state.presenter || this.state.presenting) return
    this.set({ following: true })
    this.drive()
  }

  private stopPolling() {
    if (this.poll) clearInterval(this.poll)
    this.poll = null
    this.settledPath = null
  }

  private startPolling() {
    if (this.poll) return
    this.poll = setInterval(() => this.checkPath(), PATH_POLL_MS)
  }

  /** Any route change I did not make while following = the reader went somewhere: stop. */
  private checkPath() {
    if (!this.state.following) return this.stopPolling()
    const nav = this.navigated
    if (nav && Date.now() < nav.until) return
    const now = this.path()
    if (this.settledPath === null) {
      this.settledPath = now
      return
    }
    if (now !== this.settledPath) this.stopFollowing()
  }

  private onView() {
    if (this.state.presenting) {
      this.queueMove()
      return
    }
    const target = this.state.target
    if (!this.state.following || !target || !this.navigated) return
    if (Date.now() < this.navigated.until && sameRecord(currentRecordView(), target)) {
      // The page I navigated to is up: it settles here.
      this.navigated = { ...this.navigated, until: 0 }
      this.settledPath = this.path()
      this.applyPosition(400)
    }
  }

  /** Bring my page to the presenter's record, tab and section. */
  private drive() {
    const target = this.state.target
    if (!this.state.following || !target) return
    this.startPolling()
    const view = currentRecordView()
    if (sameRecord(view, target)) {
      this.applyPosition(120)
      return
    }
    const key = `${target.collection}:${target.id}`
    // Navigated there already and no record page showed (no access → the host's not-found):
    // never loop navigating on every move.
    if (this.navigated?.key === key) return
    if (!this.nav) return
    this.navigated = { key, until: Date.now() + NAV_SETTLE_MS }
    this.settledPath = null
    const query = target.step ? { step: target.step } : null
    this.nav.navigate(this.nav.urlFor({ collection: target.collection, itemId: target.id, query }))
  }

  private applyPosition(delayMs: number) {
    const target = this.state.target
    if (!target) return
    const key = `${target.collection}:${target.id}:${target.step}:${target.section}`
    if (this.applied === key) return
    this.applied = key
    if (target.step) applyFollowStep(target.collection, target.id, target.step)
    const section = target.section
    if (section && typeof document !== 'undefined') {
      setTimeout(() => {
        if (this.state.following && this.state.target?.section === section) scrollToSection(section)
      }, delayMs)
    }
  }

  private setAsked(asked: FollowState['asked']) {
    if (this.askTimer) clearTimeout(this.askTimer)
    this.askTimer = null
    this.set({ asked })
    // An unanswered ask lapses; a "no" shows for a moment.
    if (asked)
      this.askTimer = setTimeout(
        () => this.set({ asked: null }),
        asked === 'pending' ? 20_000 : 5_000
      )
  }

  onFollow(p: FollowIn) {
    if (!p || p.room !== this.state.room) return
    const me = this.self()
    switch (p.action) {
      case 'start':
      case 'move':
      case 'state': {
        if (!p.presenter || !p.collection || p.id == null) return
        const presenting = p.presenter.socket === me
        const target = {
          collection: p.collection,
          id: String(p.id),
          step: p.step ?? null,
          section: p.section ?? null
        }
        const changedPresenter = this.state.presenter?.socket !== p.presenter.socket
        // A new presentation follows everyone; after Stop, moves alone do not pull me back.
        const following = presenting
          ? false
          : p.action === 'move' && !changedPresenter
            ? this.state.following
            : true
        if (presenting) this.beginPresenting()
        else this.endPresenting()
        this.set({
          presenter: p.presenter,
          target,
          presenting,
          following,
          error: null,
          asked: presenting ? null : this.state.asked
        })
        if (!following) this.stopPolling()
        if (changedPresenter) this.navigated = null
        this.drive()
        return
      }
      case 'stop': {
        if (
          this.state.presenter &&
          p.presenter &&
          this.state.presenter.socket !== p.presenter.socket
        )
          return
        this.endPresenting()
        this.stopPolling()
        this.navigated = null
        this.set({
          presenter: null,
          target: null,
          presenting: false,
          following: false,
          request: null
        })
        return
      }
      case 'request':
        if (this.state.presenting && p.from) this.set({ request: p.from })
        return
      case 'granted':
        this.setAsked(null)
        this.set({ presenter: null })
        this.start(this.state.target)
        return
      case 'declined':
        this.setAsked('declined')
        return
    }
  }

  onDenied(p: { room: string; reason: string; presenter?: FollowPerson }) {
    if (!p || p.room !== this.state.room) return
    if (p.reason === 'busy' && p.presenter) {
      this.set({ presenter: p.presenter })
      return
    }
    const text: Record<string, string> = {
      'not-record': 'Follow me works in a record’s room.',
      'no-record': 'The record for this room could not be opened.',
      'no-access': 'You no longer have access to this room.'
    }
    if (text[p.reason]) this.set({ error: text[p.reason] })
  }

  clearError() {
    this.set({ error: null })
  }

  /** Test seam. */
  dispose() {
    this.endPresenting()
    this.stopPolling()
    for (const off of this.offBus) off()
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

const transport = () => huddleStore.transportNow()
const selfSocket = () => huddleStore.getSnapshot().self

export const huddleNotes = new HuddleNoteStore(transport, selfSocket)
export const huddleFollow = new HuddleFollowStore(transport, selfSocket)

let attached: HuddleTransport | null = null
let offs: Array<() => void> = []
let lastKey: string | null = null

/** The huddle I am live in (null otherwise) — notes and follow live only that long. */
function liveRoom(s: HuddleState): string | null {
  return s.status === 'live' && s.room ? s.room : null
}

function onHuddleChange() {
  const s = huddleStore.getSnapshot()
  const room = liveRoom(s)
  const key = room ? `${room}|${s.self}` : null
  if (key === lastKey) return
  lastKey = key
  huddleNotes.reset(room)
  huddleFollow.reset(room)
  // A (re)join: ask for the current note and presenter.
  if (room) attached?.emit('huddle:collab:sync', { room })
}

/** Bind once per host adapter; called by the huddle UI that needs it (idempotent). */
export function attachHuddleCollab(t: HuddleTransport | null) {
  if (!t || attached === t) return
  for (const off of offs) off()
  attached = t
  lastKey = null
  offs = [
    t.on('huddle:note', (p: NoteIn) => huddleNotes.onNote(p)),
    t.on('huddle:note:denied', (p: { room: string; reason: string; rev?: number }) =>
      huddleNotes.onDenied(p)
    ),
    t.on('huddle:note:unposted', (p: { room: string; reason: string }) =>
      huddleNotes.onUnposted(p)
    ),
    t.on('huddle:note:kept', (p: { room: string; text: string }) => huddleNotes.onKept(p)),
    t.on('huddle:follow', (p: FollowIn) => huddleFollow.onFollow(p)),
    t.on('huddle:follow:denied', (p: { room: string; reason: string; presenter?: FollowPerson }) =>
      huddleFollow.onDenied(p)
    ),
    huddleStore.subscribe(onHuddleChange),
    huddleStore.onBeforeLeave(() => huddleNotes.flush())
  ]
  onHuddleChange()
}
