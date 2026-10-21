// Layout AI helpers in the editor (#2694 #2695 #2676 #2693).

export { AskButton, AskPanel, type AskPanelProps } from './AskPanel'
export {
  type AskCite,
  type AskTurn,
  assistKeys,
  type DiffSide,
  type LayoutDiffExplanation,
  type LayoutProposal,
  useExplainLayoutDiff,
  useLayoutProposals
} from './assist-api'
export { ExplainDiffButton, ExplainDiffView } from './ExplainDiff'
export { type JumpEnv, type JumpResult, jumpToSetting } from './jump'
export { ProposalsButton } from './ProposalsButton'
export {
  isWhereQuestion,
  type SettingEntry,
  type SettingHit,
  searchSettings,
  settingEntry,
  settingsIndex
} from './settings-index'
