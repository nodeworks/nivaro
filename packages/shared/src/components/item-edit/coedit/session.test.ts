// @vitest-environment jsdom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetCoeditRegistry, coeditCovers, coeditLive } from '../../../lib/coedit-registry'
import { COEDIT_REMOTE } from './collab'
import { CoeditCursors } from './cursors'
import { CoeditSession, type CoeditTransport } from './session'

/**
 * Realtime round 3 item 8 — two (or three) editors writing in one field through a stand-in for
 * the server (the same rules as api services/coedit-socket.ts + coedit.ts: one session per
 * field, a batch accepted only at the newest version, others' batches broadcast to everyone,
 * a stale one answered with the steps it missed). Every message is queued, so editors really
 * do type at the same time before anything arrives.
 */

const target = { collection: 'orders', item: '7', field: 'notes' }

type Msg = { to: 'server' | string; from: string; event: string; payload: any }

class Hub {
  queue: Msg[] = []
  listeners = new Map<string, Map<string, Array<(p: any) => void>>>()
  writers = new Set<string>()
  session: { sid: string; doc: unknown; steps: Array<{ s: unknown; c: string }> } | null = null
  members = new Set<string>()
  n = 0

  transport(id: string, write: boolean): CoeditTransport {
    if (write) this.writers.add(id)
    this.listeners.set(id, new Map())
    return {
      emit: (event, payload) => this.queue.push({ to: 'server', from: id, event, payload }),
      on: (event, cb) => {
        const map = this.listeners.get(id) as Map<string, Array<(p: any) => void>>
        const list = map.get(event) ?? []
        list.push(cb)
        map.set(event, list)
        return () =>
          map.set(
            event,
            (map.get(event) ?? []).filter((x) => x !== cb)
          )
      }
    }
  }

  private send(to: string, event: string, payload: any) {
    this.queue.push({ to, from: 'server', event, payload: { ...target, ...payload } })
  }
  private everyone(event: string, payload: any, except?: string, writersOnly = false) {
    for (const id of this.listeners.keys())
      if (id !== except && (!writersOnly || this.writers.has(id))) this.send(id, event, payload)
  }
  private out() {
    const s = this.session
    return s
      ? { sid: s.sid, version: s.steps.length, baseVersion: 0, doc: s.doc, steps: s.steps }
      : null
  }

  private serve(m: Msg) {
    const p = m.payload
    const write = this.writers.has(m.from)
    switch (m.event) {
      case 'coedit:watch':
        this.send(m.from, 'coedit:state', { write, session: this.out() })
        break
      case 'coedit:open':
        if (!write) return
        this.members.add(`${m.from}:${p.clientID}`)
        if (!this.session) {
          this.session = { sid: `s${++this.n}`, doc: p.doc, steps: [] }
          this.everyone('coedit:active', { session: this.out(), by: p.clientID })
        } else this.send(m.from, 'coedit:state', { write, session: this.out() })
        break
      case 'coedit:steps': {
        const s = this.session
        if (!write || !s || p.sid !== s.sid) return
        if (p.version !== s.steps.length) {
          this.send(m.from, 'coedit:steps', {
            sid: s.sid,
            version: p.version,
            steps: s.steps.slice(p.version).map((x) => x.s),
            clientIDs: s.steps.slice(p.version).map((x) => x.c)
          })
          return
        }
        for (const step of p.steps) s.steps.push({ s: step, c: p.clientID })
        this.everyone('coedit:steps', {
          sid: s.sid,
          version: p.version,
          steps: p.steps,
          clientIDs: p.steps.map(() => p.clientID)
        })
        break
      }
      case 'coedit:sync':
        if (p.version == null || !this.session || p.sid !== this.session.sid)
          this.send(m.from, 'coedit:state', { write, session: this.out() })
        break
      case 'coedit:cursor':
        if (write)
          this.everyone('coedit:cursor', { ...p, user: { id: m.from, name: m.from } }, m.from, true)
        break
      case 'coedit:close':
        this.members.delete(`${m.from}:${p.clientID}`)
        if (this.members.size === 0 && this.session) {
          this.session = null
          this.everyone('coedit:ended', { reason: 'left' })
        }
        break
    }
  }

  /** Deliver everything (and what that causes) until nothing is left. */
  flush() {
    for (let guard = 0; this.queue.length && guard < 10_000; guard++) {
      const m = this.queue.shift() as Msg
      if (m.to === 'server') this.serve(m)
      else for (const cb of this.listeners.get(m.to)?.get(m.event) ?? []) cb(m.payload)
    }
  }
}

interface Person {
  editor: Editor
  session: CoeditSession
  form: { value: string; saved: string }
  focus(): void
  blur(): void
}

const editors: Editor[] = []

function person(hub: Hub, id: string, html: string, opts: { write?: boolean } = {}): Person {
  const write = opts.write !== false
  const form = { value: html, saved: html }
  let focused = false
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, CoeditCursors],
    content: html,
    editable: write
  })
  editors.push(editor)
  Object.defineProperty(editor, 'isFocused', { get: () => focused })
  let session: CoeditSession | null = null
  // What RichTextEditorImpl's onUpdate does: others' typing reaches the form only for someone
  // who changed the field.
  editor.on('update', ({ transaction }) => {
    if (transaction.getMeta(COEDIT_REMOTE) && !session?.tracking()) return
    form.value = editor.getHTML()
  })
  session = new CoeditSession(editor, target, hub.transport(id, write), {
    fieldDirty: () => form.value !== form.saved,
    formValue: () => form.value,
    resetTo: (v) => editor.commands.setContent(v, { emitUpdate: false })
  })
  session.start()
  return {
    editor,
    session,
    form,
    focus() {
      focused = true
      editor.emit('focus', { editor, event: new FocusEvent('focus'), transaction: editor.state.tr })
    },
    blur() {
      focused = false
      editor.emit('blur', { editor, event: new FocusEvent('blur'), transaction: editor.state.tr })
    }
  }
}

/** Type at a position (the person's own transaction). */
function typeAt(p: Person, pos: number, text: string) {
  p.editor.view.dispatch(p.editor.state.tr.insertText(text, pos))
}
const endOf = (p: Person) => p.editor.state.doc.content.size - 1

beforeEach(() => __resetCoeditRegistry())
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
})

describe('co-editing a long text field', () => {
  it('merges two people typing at the same time into one document', () => {
    const hub = new Hub()
    const ana = person(hub, 'ana', '<p>Hello world</p>')
    const ben = person(hub, 'ben', '<p>Hello world</p>')
    hub.flush()
    ana.focus()
    ben.focus()
    hub.flush()
    // Both type before either hears of the other.
    typeAt(ana, 1, 'Ana: ')
    typeAt(ben, endOf(ben), ' — Ben')
    typeAt(ana, 6, '!')
    typeAt(ben, endOf(ben), '.')
    hub.flush()
    const a = ana.editor.getHTML()
    expect(a).toBe(ben.editor.getHTML())
    expect(ana.editor.getText()).toBe('Ana: !Hello world — Ben.')
    expect(hub.session?.steps.length).toBe(4)
    expect(coeditLive(target.collection, target.item, target.field)).toBe(true)
  })

  it('a reply that crossed newer steps changes nothing (no rewind of what was typed)', () => {
    const hub = new Hub()
    const ana = person(hub, 'ana', '<p>Base</p>')
    const ben = person(hub, 'ben', '<p>Base</p>')
    hub.flush()
    ana.focus()
    hub.flush()
    typeAt(ana, endOf(ana), ' one')
    hub.flush()
    const old = (hub as any).out()
    ben.focus()
    hub.flush()
    typeAt(ana, endOf(ana), ' two')
    typeAt(ben, 1, 'Ben ')
    hub.flush()
    const before = ben.editor.getText()
    // The open's answer, computed before the newer steps, arrives late.
    for (const cb of hub.listeners.get('ben')?.get('coedit:state') ?? [])
      cb({ ...target, write: true, session: old })
    expect(ben.editor.getText()).toBe(before)
    expect(ben.session.isLive()).toBe(true)
    typeAt(ben, endOf(ben), '!')
    hub.flush()
    expect(ana.editor.getText()).toBe('Ben Base one two!')
  })

  it('shows the other writer’s cursor with their name, and keeps it in place as text arrives', () => {
    const hub = new Hub()
    const ana = person(hub, 'ana', '<p>abc</p>')
    const ben = person(hub, 'ben', '<p>abc</p>')
    hub.flush()
    ana.focus()
    ben.focus()
    hub.flush()
    ben.editor.commands.setTextSelection(3)
    // The cursor goes out on a short timer; send it now.
    ;(ben.session as any).sendCursor(false)
    hub.flush()
    const cursors = (ana.editor.storage as any).coeditCursors.cursors
    expect(cursors).toHaveLength(1)
    expect(cursors[0]).toMatchObject({ name: 'ben', head: 3 })
    typeAt(ana, 1, 'XY')
    hub.flush()
    expect((ana.editor.storage as any).coeditCursors.cursors[0].head).toBe(5)
  })

  it('a reader sees the text but no cursors, and their form never changes', () => {
    const hub = new Hub()
    const ana = person(hub, 'ana', '<p>Notes</p>')
    const cy = person(hub, 'cy', '<p>Notes</p>', { write: false })
    hub.flush()
    ana.focus()
    hub.flush()
    typeAt(ana, endOf(ana), ' added')
    ;(ana.session as any).sendCursor(false)
    hub.flush()
    expect(cy.editor.getText()).toBe('Notes added')
    expect((cy.editor.storage as any).coeditCursors.cursors).toHaveLength(0)
    expect(cy.form.value).toBe('<p>Notes</p>')
  })

  it('someone with their own unsaved edits stays apart (merge at save), others adopt', () => {
    const hub = new Hub()
    const dee = person(hub, 'dee', '<p>Base</p>')
    hub.flush()
    // Dee changed the field before anyone was writing in it (no session yet: alone, offline…).
    dee.session.disconnected()
    typeAt(dee, endOf(dee), ' mine')
    expect(dee.form.value).toBe('<p>Base mine</p>')
    const ana = person(hub, 'ana', '<p>Base</p>')
    hub.flush()
    ana.focus()
    hub.flush()
    typeAt(ana, endOf(ana), ' theirs')
    dee.session.watch()
    hub.flush()
    expect(dee.editor.getText()).toBe('Base mine')
    expect(dee.form.value).toBe('<p>Base mine</p>')
    expect(dee.session.isLive()).toBe(false)
  })

  it('one save: the other writer’s draft is that value, so it is no conflict and nothing more to save', () => {
    const hub = new Hub()
    const ana = person(hub, 'ana', '<p>Plan</p>')
    const ben = person(hub, 'ben', '<p>Plan</p>')
    hub.flush()
    ana.focus()
    ben.focus()
    hub.flush()
    typeAt(ana, endOf(ana), ' — step 1')
    typeAt(ben, 1, 'Draft: ')
    hub.flush()
    expect(ana.form.value).toBe(ben.form.value)
    // Ana saves (the normal Save through the items service): this is the stored value.
    const stored = ana.form.value
    ana.form.saved = stored
    // Ben's form gets the saved record: the value is a state of the session he is in…
    expect(coeditCovers(target.collection, target.item, target.field, stored)).toBe(true)
    // …and his draft already is that value: the form follows the server, nothing left to save.
    ben.form.saved = stored
    expect(ben.form.value).toBe(ben.form.saved)
    // A value the session never held (saved from somewhere else) is still a conflict.
    expect(coeditCovers(target.collection, target.item, target.field, '<p>other</p>')).toBe(false)
  })

  it('the last writer leaving ends the session; a watcher goes back to the saved value', async () => {
    const hub = new Hub()
    const ana = person(hub, 'ana', '<p>Start</p>')
    const cy = person(hub, 'cy', '<p>Start</p>', { write: false })
    hub.flush()
    ana.focus()
    hub.flush()
    typeAt(ana, endOf(ana), ' unsaved')
    hub.flush()
    expect(cy.editor.getText()).toBe('Start unsaved')
    ana.blur()
    hub.flush()
    expect(hub.session).toBeNull()
    expect(cy.session.isLive()).toBe(false)
    await new Promise((r) => setTimeout(r, 2_700))
    expect(cy.editor.getText()).toBe('Start')
    // Ana's draft keeps what she typed (it saves the normal way).
    expect(ana.form.value).toBe('<p>Start unsaved</p>')
  })
})
