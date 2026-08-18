// Full styled form from @nivaro/shared

// SDK re-exports (types useful in form consumers)
export type { CascadeFilterRule, FieldDependencyConfig } from '@nivaro/sdk'
export type {
  ExprValue,
  FormulaEditorProps,
  FormulaField,
  CollectionBrowserColumn,
  CollectionBrowserViewProps,
  DrilldownTarget,
  ItemEditFormProps,
  ItemLinkTarget,
  OverlayHistory,
  PageRendererPage,
  PageRendererProps,
  PageRendererWidget,
  QueueRealtimeAdapter,
  QueueWorklistProps,
  ReportViewProps
} from '@nivaro/shared'
export {
  canPreviewFile,
  CollectionBrowserView,
  CommentPanel,
  FilePreviewLightbox,
  MyWorkView,
  UserAvatar,
  FormulaEditor,
  evaluateBoolean,
  evaluateExpression,
  evaluateNumeric,
  extractExpressionTokens,
  parseExpression,
  validateExpression,
  DataTable,
  defaultItemUrl,
  GridFlushContext,
  ItemEditAuthContext,
  ItemEditForm,
  ItemLockBanner,
  NavigationContext,
  OwnerAvatars,
  PageRenderer,
  PipelinePanel,
  PipelineTransitionButtons,
  QueueBulkBar,
  QueueItemSheet,
  QueueKanbanBoard,
  QueueWorklist,
  QueueWorkloadView,
  RecordDrilldownSheet,
  DrilldownContext,
  useDrilldown,
  OverlayHistoryContext,
  useOverlayState,
  ChatPanel,
  ChatProvider,
  ChatRoomList,
  ChatRoomView,
  useChatConfig,
  useChatMessages,
  useChatRooms,
  useMarkRoomRead,
  usePeerReadAt,
  useSendChatMessage,
  useTypingIndicator,
  useUnreadChirp,
  dmRoom,
  dmPeer,
  splitMessageTokens,
  getMentionQuery,
  canOpenDm,
  chatAvatarColor,
  chatInitials,
  openDmWith,
  registerDmOpener,
  type ChatMessage,
  type ChatConfig,
  type ChatOnlineUser,
  type ChatTheme,
  type RoomInfo,
  ProfileView,
  AlertManagerView,
  type AlertManagerViewProps,
  CollectionImportPanel,
  ImportConsole,
  type ImportConsoleProps,
  type ImportConsoleTab,
  type ImportDefinition,
  type ImportJob,
  type ImportJobStatus,
  type ImportPreview,
  type ImportProgressEvent,
  type ImportRealtimeAdapter,
  type ImportRun,
  type ImportRunStatus,
  type ImportStats,
  QueryWidgetBody,
  effectiveScopeSeedIds,
  matchScopeDimension,
  translateScopeValues,
  useMyScopes,
  ReportView,
  RevisionsPanel,
  TaskPanel,
  useGridFlush,
  useItemEditAuth,
  useItemLock,
  useItemNavigation,
  useNavigation,
  WorkflowPanel
} from '@nivaro/shared'
export { BooleanField } from './components/fields/BooleanField'
export { DateField } from './components/fields/DateField'
export { FileField } from './components/fields/FileField'
export { NumberField } from './components/fields/NumberField'
export { RelationField } from './components/fields/RelationField'
export { SelectField } from './components/fields/SelectField'
export { TextareaField } from './components/fields/TextareaField'
export { TextField } from './components/fields/TextField'
export type { SlotRendererProps } from './components/LayoutForm'
export { LayoutForm } from './components/LayoutForm'
export { NivaroField } from './components/NivaroField'
// Components
export { NivaroForm } from './components/NivaroForm'
// Context
export { NivaroProvider, useNivaroClient } from './context'
export {
  clearFormSchemaCache,
  fetchSchema,
  normalizeFieldType,
  useFormSchema
} from './hooks/useFormSchema'
export type {
  FieldArrayReturn,
  FieldState,
  FormDirtyState,
  FormStatus,
  LayoutItem,
  SectionState,
  TabState
} from './hooks/useLayoutHooks'
// Layout hooks
export {
  useFieldArray,
  useFieldState,
  useFormDirty,
  useFormStatus,
  useOrderedLayout,
  useSectionState,
  useTabState,
  useWatchFields
} from './hooks/useLayoutHooks'
// Hooks
export { useNivaroForm } from './hooks/useNivaroForm'
export type { RelationOption } from './hooks/useRelationOptions'
export { useRelationOptions } from './hooks/useRelationOptions'
export type { SessionRecorderOptions } from './hooks/useSessionRecorder'
export { useSessionRecorder } from './hooks/useSessionRecorder'
// Types
export type {
  ComponentOverrides,
  FieldComponentProps,
  FormErrors,
  FormFieldDescriptor,
  FormFieldType,
  FormGroupDescriptor,
  FormLockCondition,
  FormSchema,
  FormSlotAssignment,
  FormValidationRule,
  FormVisibilityRule,
  UseNivaroFormOptions,
  UseNivaroFormReturn
} from './types'
export { UserChip, UserRosterCluster } from '@nivaro/shared'
export { ApiUpdateBanner, TipLayer, startApiVersionWatch, useApiUpdate, getApiUpdate } from '@nivaro/shared'
export type { ApiVersionInfo } from '@nivaro/shared'
export { IDLE_AFTER_MS, idleState, onIdleChange, trackActivity } from '@nivaro/shared'
export { canOpenChatRoom, openChatRoom, registerRoomOpener } from '@nivaro/shared'
export { resolveNotificationTarget, runNotificationTarget, type NotificationRouteMap, type NotificationTarget } from '../../shared/src/lib/notification-target'
