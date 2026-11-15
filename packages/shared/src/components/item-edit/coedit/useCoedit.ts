import type { Editor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { useOptionalRealtime, useRealtimeStatus } from '../../../lib/realtime'
import type { CoeditFieldTarget } from './context'
import { type CoeditPeer, CoeditSession } from './session'

const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '')

export interface CoeditBinding {
  session: CoeditSession | null
  /** Others are writing here and the person's own unsaved edits stay apart from theirs. */
  diverged: boolean
  /** The others writing in the field right now. */
  peers: CoeditPeer[]
}

/**
 * Bind a mounted Tiptap editor to its field's writing session over the host's realtime
 * adapter. Without an adapter (or a target) it does nothing: the editor is a plain editor.
 */
export function useCoedit(
  editor: Editor | null,
  target: CoeditFieldTarget | null,
  value: string,
  toHtml: (v: string) => string
): CoeditBinding {
  const realtime = useOptionalRealtime()
  const status = useRealtimeStatus()
  const [session, setSession] = useState<CoeditSession | null>(null)
  const [diverged, setDiverged] = useState(false)
  const [peers, setPeers] = useState<CoeditPeer[]>([])
  const valueRef = useRef(value)
  valueRef.current = value
  const savedRef = useRef(target?.saved)
  savedRef.current = target?.saved
  const toHtmlRef = useRef(toHtml)
  toHtmlRef.current = toHtml
  const collection = target?.collection
  const item = target?.item
  const field = target?.field

  useEffect(() => {
    if (!editor || !realtime || !collection || !item || !field) return
    const s = new CoeditSession(
      editor,
      { collection, item, field },
      {
        emit: (event, payload) => realtime.emit(event, payload),
        on: (event, cb) => realtime.on(event, cb)
      },
      {
        fieldDirty: () => !same(valueRef.current, savedRef.current?.()),
        formValue: () => valueRef.current,
        resetTo: (v) => {
          if (editor.isDestroyed) return
          const html = toHtmlRef.current(v)
          if (editor.getHTML() !== html) editor.commands.setContent(html, { emitUpdate: false })
        },
        onDiverged: setDiverged,
        onPeers: setPeers
      }
    )
    s.start()
    setSession(s)
    return () => {
      s.dispose()
      setSession(null)
      setDiverged(false)
      setPeers([])
    }
  }, [editor, realtime, collection, item, field])

  // A dropped connection: carry on as a plain editor; back again: watch the field again (a
  // reconnect is a new socket with no rooms).
  const wasDown = useRef(false)
  useEffect(() => {
    if (!session) return
    if (status?.state === 'reconnecting') {
      if (!wasDown.current) session.disconnected()
      wasDown.current = true
    } else if (wasDown.current && status?.state === 'live') {
      wasDown.current = false
      session.watch()
    }
  }, [status?.state, session])

  return { session, diverged, peers }
}
