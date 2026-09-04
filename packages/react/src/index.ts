// Full styled form from @nivaro/shared

// SDK re-exports (types useful in form consumers)
export type { CascadeFilterRule, FieldDependencyConfig } from '@nivaro/sdk'
// Expression engine result types (the functions were already exported)
export type {
  ApiVersionInfo,
  ChatProviderProps,
  CollectionBrowserColumn,
  CollectionBrowserViewProps,
  Column,
  ColumnFormatConfig,
  DataTableProps,
  DrilldownContextValue,
  DrilldownViewOverride,
  DrilldownTarget,
  EvaluateOptions,
  ExprNode,
  ExprValue,
  FieldDrilldownConfig,
  FilterDef,
  FormulaEditorProps,
  FormulaField,
  GridFlushContextValue,
  HeaderWidgetInfo,
  ItemEditAuthContextValue,
  ItemEditFormProps,
  ItemLinkTarget,
  M2MStagingCtx,
  NavigationContextValue,
  OverlayHistory,
  PageRendererPage,
  PageRendererProps,
  PageRendererWidget,
  ParseResult,
  QueueGroup,
  QueueRealtimeAdapter,
  QueueWorklistProps,
  ReadViewLayout,
  RenderFieldProps,
  ReportViewProps,
  TokenResolver
} from '@nivaro/shared'
// ─── Realtime sprint 2026-08-24 ─────────────────────────────────────────────
export {
  RealtimeContext,
  useOptionalRealtime,
  createLeaderSocket,
  useOnlineUsers
} from '@nivaro/shared'
export type { RealtimeAdapter, CollectionUpdateEvent, LeaderSocketHandle } from '@nivaro/shared'
// ─── Parity sweep 2026-08-19 — shared surfaces headless hosts need ──────────
// Feature components
// Panels — completes the set (siblings were already exported)
// Item-edit building blocks for hosts composing custom edit shells
// Imports
// Alerts — drawers + the data types AlertManagerView consumers handle
// DataTable typing surface (the component was exported, its props were not)
// Formatting + behavior libs hosts must match, not reimplement
// Context surface — value types + the optional-client/config hooks
// Chat — the rest of the hook set + channel admin surfaces
export {
  ACTIVE_USER_OPTION_FILTER,
  AccessDeniedPanel,
  AddendumPanel,
  AlertManagerView,
  type AlertManagerViewProps,
  AlertRuleDrawer,
  AnomalyRuleDrawer,
  SlaRulesView,
  type SlaRule,
  ApiUpdateBanner,
  agingBucket,
  applyValidationRule,
  buildGroups,
  CellCopyLayer,
  ChatChannelBrowser,
  ChatChannelSettings,
  type ChatConfig,
  type ChatMessage,
  type ChatOnlineUser,
  ChatPanel,
  ChatProvider,
  ChatRoomList,
  ChatRoomView,
  type ChatTheme,
  CloneDialog,
  CollectionBrowserView,
  AnnouncementBanner,
  BroadcastView,
  ConformanceView,
  CollectionImportPanel,
  CommentPanel,
  canOpenChatRoom,
  canOpenDm,
  canPreviewFile,
  chatAvatarColor,
  chatInitials,
  choiceLabel,
  DataTable,
  DrilldownContext,
  DrilldownViewsContext,
  defaultItemUrl,
  deriveGroupKey,
  dmPeer,
  dmRoom,
  ErpFailureBanner,
  ExternalRequestsChip,
  effectiveScopeSeedIds,
  evaluateBoolean,
  evaluateExpression,
  evaluateNumeric,
  extractExpressionTokens,
  FieldRenderer,
  FilePreviewLightbox,
  FilterControl,
  FormulaEditor,
  fieldDrilldownConfig,
  filterDefLabel,
  filterValueDisplay,
  formatDate,
  formatDateTime,
  formatFileSize,
  formatMultiValue,
  formatNumber,
  formatRelative,
  formatValue,
  GridFlushContext,
  getApiUpdate,
  getMentionQuery,
  HScrollProxy,
  IDLE_AFTER_MS,
  ImportConsole,
  type ImportConsoleProps,
  type ImportConsoleTab,
  type ImportDefinition,
  ImportFromFileButton,
  ImportIssuesPanel,
  type ImportJob,
  type ImportJobStatus,
  type ImportPreview,
  type ImportProgressEvent,
  type ImportRealtimeAdapter,
  type ImportRun,
  type ImportRunStatus,
  type ImportStats,
  InlineTableField,
  ItemActionButtons,
  ItemEditAuthContext,
  ItemEditForm,
  ItemLockBanner,
  idleState,
  JsonMapEditor,
  MatrixEditor,
  MyWorkView,
  matchScopeDimension,
  NavigationContext,
  type NotificationRouteMap,
  NotificationSourcesCard,
  type NotificationTarget,
  numericIntlOptions,
  OverlayHistoryContext,
  OwnerAvatars,
  OwnerGapsCard,
  OwnerMatrix,
  OwnersSlot,
  onIdleChange,
  openChatRoom,
  openDmWith,
  AiReviewCard,
  PageRenderer,
  type PipelineEditorSection,
  PipelineEditorView,
  TeamScopeEditor,
  TeamsView,
  rankTeamForFilters,
  useScopeDimensions,
  PipelinePanel,
  PipelineSimulatorCard,
  PipelineTransitionButtons,
  ProfileView,
  TimezoneCard,
  DisplayPrefsCard,
  NotificationRulesCard,
  ProfileFieldsCard,
  FirstLoginChecklist,
  CommandCenterView,
  BaseMap,
  parseExpression,
  precisionOf,
  QueryStatStrip,
  QueryTable,
  QueryWidgetBody,
  QualityRulesView,
  QueueBulkBar,
  QueueItemSheet,
  QueueKanbanBoard,
  QueueWorklist,
  QueueWorkloadView,
  REACTION_EMOJI,
  RecordChatActions,
  RecordDrilldownSheet,
  RecordGridEditor,
  RecordReadView,
  RecordRecapStrip,
  RecordSubscribeButton,
  RelatedRecordsPanel,
  RelationCombobox,
  ReportView,
  RevisionsPanel,
  ROW_HIGHLIGHT_TINTS,
  type RoomInfo,
  registerDmOpener,
  registerRoomOpener,
  resolveCollectionIcon,
  resolveNotificationTarget,
  rowHighlightClass,
  rowHighlightTextClass,
  runNotificationTarget,
  splitMessageTokens,
  startApiVersionWatch,
  TaskPanel,
  TipLayer,
  titleCase,
  trackActivity,
  startRum,
  rumRouteChange,
  translateScopeValues,
  UserAvatar,
  UserChip,
  UserRosterCluster,
  useApiFetchConfig,
  useApiUpdate,
  useChannelAdmin,
  useChannelDirectory,
  useChannelMembers,
  useChatConfig,
  useChatMessages,
  useChatRoles,
  useChatRooms,
  useChatSearch,
  useCreateChannel,
  useCreateGroupDm,
  useDeleteMessage,
  useDrilldown,
  useDrilldownViews,
  useEditMessage,
  useEntityRoomLink,
  useGridFlush,
  useItemEditAuth,
  useItemLock,
  useItemNavigation,
  useMarkRoomRead,
  useMyScopes,
  useNavigation,
  useOptionalNivaroClient,
  useOverlayState,
  usePeerReadAt,
  useRoomMembership,
  useRoomPins,
  useSendChatMessage,
  useTogglePin,
  useToggleReaction,
  useTypingIndicator,
  useUnreadChirp,
  useUserSearch,
  validateExpression,
  WidgetSlot,
  WorkflowPanel
} from '@nivaro/shared'
// Re-export sweep (2026-08-25): shared surface that headless hosts were
// missing — display-pref setters, the fiscal/formula/layout-slot libs,
// field-interface registry, and the utility components/hooks below.
export { useFeatureFlag, useFeatureFlags } from '@nivaro/shared'
export {
  registerCatalogItemOpener,
  canOpenCatalogItem,
  openCatalogItem
} from '@nivaro/shared'
export { playNotificationSound, type NotificationSound } from '@nivaro/shared'
export {
  setDisplayTimezone,
  setTimeDisplay,
  setNumberFormat,
  setFiscalStartMonth,
  getFiscalStartMonth,
  fiscalYearOf,
  fiscalQuarterOf,
  fiscalPeriodOf,
  setFormulaConstants,
  formulaConstant,
  networkdaysBetween,
  registerLayoutSlot,
  getLayoutSlot,
  extSlotKey,
  CustomActionButtons,
  AutolinkedText,
  ReviewListWidget,
  DefinitionsPanel,
  NewImportDialog,
  QueryWidgetView,
  RecordGridWidgetBody,
  TickerNumber,
  CronBuilder,
  describeCron,
  EmptyState,
  ErrorSurface,
  OfflineBanner,
  useDebounced,
  useFileHealth,
  useElapsedLoading
} from '@nivaro/shared'
export {
  registerFieldInterface,
  getFieldInterface,
  listFieldInterfaces,
  onFieldInterfacesChange
} from '@nivaro/shared'
export type {
  FieldInterfaceProps,
  FieldInterfaceHandle,
  FieldInterfacePlugin,
  BaseMapPin,
  BaseMapBubble
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
export {
  captureErrorClip,
  type ErrorReplayLink,
  type SessionRecorderOptions,
  useSessionRecorder
} from './hooks/useSessionRecorder'
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
export { ChangeReasonDialog, changeReasonChallenge } from '@nivaro/shared'
export type { ChangeReasonChallenge } from '@nivaro/shared'
