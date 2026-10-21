import { createContext, useContext } from 'react'

/**
 * What the Form settings panel and the inspector may ask of the editor shell for
 * the entry tools: start the tab order overlay (#2708). Hosts without the shell
 * (tests) get no-ops.
 */
export interface EntryEditorApi {
  tabOrderActive: boolean
  startTabOrder(): void
}

export const EntryEditorContext = createContext<EntryEditorApi>({
  tabOrderActive: false,
  startTabOrder: () => {}
})

export const useEntryEditor = () => useContext(EntryEditorContext)
