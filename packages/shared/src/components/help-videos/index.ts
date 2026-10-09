export {
  helpVideoApi,
  helpVideoKeys,
  useHelpVideo,
  useHelpVideosFor,
  useHelpVideoWalk,
  useRequiredVideos
} from './api'
export { HelpVideoEditor } from './editor/HelpVideoEditor'
export { HelpVideoPlayer, type PlayerHandle } from './HelpVideoPlayer'
export { AuthorRolesButton } from './library/AuthorRolesButton'
export { HelpVideoLibrary } from './library/HelpVideoLibrary'
export { HelpVideoRecorder } from './recorder/HelpVideoRecorder'
export {
  HelpVideoRecordingProvider,
  type StartRecordingOptions,
  useHelpVideoRecording
} from './recorder/HelpVideoRecordingProvider'
export type {
  HelpVideoContext,
  HelpVideoDto,
  RecordedClick,
  VideoEdits,
  WalkStep
} from './types'
export { HelpVideoButton } from './viewer/HelpVideoButton'
export { HelpVideoSheet } from './viewer/HelpVideoSheet'
export { RequiredVideosCard } from './viewer/RequiredVideosCard'
export { HelpVideoWalkHost } from './walk/HelpVideoWalk'
export {
  endHelpVideoWalk,
  registerHelpVideoPage,
  startHelpVideoWalk,
  useCurrentHelpVideoPage
} from './walk/store'
export {
  accessibleName,
  describeClickTarget,
  findStepElement,
  normalizePath,
  stepMatchesHere
} from './walk/target'
