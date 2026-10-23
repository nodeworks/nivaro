import { createContext, useContext } from 'react'
import type { TemplateDetail } from './api'

/**
 * What the editor shell shares with the Code tab and the panels without
 * widening EditorTabs' props: the autosave queue and the preview record.
 */
export interface PayloadEditorCtx {
  /** Send the waiting edit now and wait for it. False = it did not save (error or conflict). */
  saveNow: () => Promise<boolean>
  /** Drop the waiting edit (a server-side draft change is about to replace it). */
  discardPending: () => Promise<void>
  /** Refetch the template and make its stored draft the editor's draft. */
  adoptServerDraft: () => Promise<void>
  /** A 409 seen outside autosave (publish, convert): show the conflict banner. */
  raiseConflict: (current: TemplateDetail) => void
  /** The last draft save the server refused, with validateSpec's errors when it sent them. */
  saveError: { message: string; errors: string[] } | null
  /** The draft_rev the editor holds, null until the template loads. */
  rev: number | null
  /** The same, read at call time (after an awaited saveNow the render-time `rev` is old). */
  getRev: () => number | null
  /** True while an edit is waiting or being saved. */
  saving: boolean
  recordId: string | null
}

const noop = async () => {}

export const PayloadEditorContext = createContext<PayloadEditorCtx>({
  saveNow: async () => false,
  discardPending: noop,
  adoptServerDraft: noop,
  raiseConflict: () => {},
  saveError: null,
  rev: null,
  getRev: () => null,
  saving: false,
  recordId: null
})

export const usePayloadEditor = () => useContext(PayloadEditorContext)
