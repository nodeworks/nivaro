// Single context module — all exported from @nivaro/shared so that
// NivaroProvider (used by consumers) and useNivaroClient (used by ItemEditForm)
// resolve to the same React Context object.

export type { GridFlushContextValue, ItemEditAuthContextValue } from '@nivaro/shared'
export {
  GridFlushContext,
  ItemEditAuthContext,
  NivaroProvider,
  useGridFlush,
  useItemEditAuth,
  useNivaroClient,
  useOptionalNivaroClient
} from '@nivaro/shared'
