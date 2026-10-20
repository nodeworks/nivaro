// The layout editor, as its own entry (`@nivaro/react/layout-editor`). Only
// admins open it, so hosts load it behind a dynamic import and nobody else
// downloads it: keep it out of the main barrel. Its modules are the same
// dist files the barrel's own components use, so the editor shares the host's
// contexts (NivaroProvider, QueryClient, ItemEditAuthContext).

export type { LayoutEditorHost, LayoutEditorProps } from '@nivaro/shared'
export {
  ExplainButton,
  LayoutEditor,
  LayoutEditorHostContext,
  useLayoutEditorHost
} from '@nivaro/shared'
