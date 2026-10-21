import { toast } from 'sonner'
import { type FocusKind, NO_FOCUS, shortcutFor } from './huddle-audio-logic'
import { huddleStore, huddleSupport } from './huddle-store'

/**
 * Keyboard control while in a huddle (#2846): hold Space to talk while
 * muted, M mutes, Shift+S shares, L leaves (pressed twice while sharing, so a
 * stray key never drops a presentation), ? opens the cheat-sheet beside the
 * controls. Listeners exist only while I am in a huddle, and never fire while
 * focus is in a field.
 */

export interface ShortcutState {
  /** Space is held: the microphone is open until it is released. */
  talking: boolean
  /** The cheat-sheet beside the huddle controls. */
  helpOpen: boolean
}

const IDLE: ShortcutState = { talking: false, helpOpen: false }
/** How long the second L may take while sharing. */
const LEAVE_CONFIRM_MS = 3000

const INTERACTIVE =
  'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"]'
const TYPEAHEAD = '[role="listbox"], [role="menu"], [role="grid"], [role="tree"], [cmdk-root]'

export function focusKindOf(el: Element | null): FocusKind {
  if (!el || typeof (el as HTMLElement).closest !== 'function') return NO_FOCUS
  const h = el as HTMLElement
  const tag = h.tagName
  const role = h.getAttribute('role')
  const editable =
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    h.isContentEditable ||
    role === 'textbox' ||
    role === 'combobox' ||
    role === 'searchbox' ||
    role === 'spinbutton'
  return {
    editable,
    interactive: !!h.closest(INTERACTIVE),
    typeahead: !!h.closest(TYPEAHEAD),
    inHuddleControls: !!h.closest('[data-huddle-controls]')
  }
}

class ShortcutEngine {
  private state: ShortcutState = IDLE
  private listeners = new Set<() => void>()
  private bound = false
  private started = false
  private leaveArmedUntil = 0

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }
  getSnapshot = () => this.state
  private set(patch: Partial<ShortcutState>) {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  start() {
    if (this.started || typeof window === 'undefined') return
    this.started = true
    huddleStore.subscribe(() => this.sync())
    this.sync()
  }

  setHelpOpen(open: boolean) {
    if (open !== this.state.helpOpen) this.set({ helpOpen: open })
  }

  private sync() {
    const s = huddleStore.getSnapshot()
    const inHuddle = s.status === 'live' || s.status === 'joining'
    if (inHuddle && !this.bound) {
      this.bound = true
      window.addEventListener('keydown', this.onKeyDown)
      window.addEventListener('keyup', this.onKeyUp)
      window.addEventListener('blur', this.release)
      document.addEventListener('visibilitychange', this.onVisibility)
    } else if (!inHuddle && this.bound) {
      this.bound = false
      window.removeEventListener('keydown', this.onKeyDown)
      window.removeEventListener('keyup', this.onKeyUp)
      window.removeEventListener('blur', this.release)
      document.removeEventListener('visibilitychange', this.onVisibility)
      if (this.state !== IDLE) this.set(IDLE)
    }
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented && !this.state.talking) return
    const s = huddleStore.getSnapshot()
    const live = s.status === 'live'
    if (this.state.talking && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault() // key repeat while held
      return
    }
    const action = shortcutFor(e, focusKindOf(document.activeElement), {
      muted: s.muted,
      canShare: live && huddleSupport().screen
    })
    if (!action) return
    if (action === 'ptt') {
      if (e.repeat || !live) return
      e.preventDefault()
      huddleStore.setMuted(false)
      this.set({ talking: true })
      return
    }
    e.preventDefault()
    if (action === 'help') this.setHelpOpen(!this.state.helpOpen)
    else if (action === 'mute' && live && this.state.talking) {
      this.set({ talking: false }) // M while holding Space latches the microphone open
    } else if (action === 'mute' && live) huddleStore.setMuted(!s.muted)
    else if (action === 'share' && live) {
      if (s.sharing) huddleStore.stopShare()
      else void huddleStore.startShare()
    } else if (action === 'leave') this.leave(s.sharing)
  }

  private onKeyUp = (e: KeyboardEvent) => {
    if (!this.state.talking || !(e.code === 'Space' || e.key === ' ')) return
    e.preventDefault() // a focused huddle button must not "click" on release
    this.release()
  }

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.release()
  }

  /** Space let go, window blurred or tab hidden: back to muted. */
  private release = () => {
    if (!this.state.talking) return
    this.set({ talking: false })
    if (huddleStore.getSnapshot().status === 'live') huddleStore.setMuted(true)
  }

  private leave(sharing: boolean) {
    const now = Date.now()
    if (sharing && now > this.leaveArmedUntil) {
      this.leaveArmedUntil = now + LEAVE_CONFIRM_MS
      toast('Press L again to leave', {
        id: 'huddle-leave-confirm',
        description: 'You are sharing your screen.',
        duration: LEAVE_CONFIRM_MS
      })
      return
    }
    this.leaveArmedUntil = 0
    toast.dismiss('huddle-leave-confirm')
    huddleStore.leave()
  }
}

export const huddleShortcuts = new ShortcutEngine()
