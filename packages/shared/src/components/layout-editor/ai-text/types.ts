/**
 * The AI wording tools' proposals (#2677 #2678 #2679 #2681 #2682 #2683), as
 * POST /ai-design/layouts/:id/text/:tool answers them.
 *
 * MIRROR: api/src/services/ai-design/layout-text.ts TextProposal / TextResult
 * (the API cannot import packages/shared).
 */

export type TextTool = 'glossary' | 'intros' | 'placeholders' | 'choices' | 'reading' | 'translate'

export type TextTarget =
  | { kind: 'placement'; field: string; group_key: string | null }
  | { kind: 'group'; key: string }

export type TextKey = 'label' | 'note' | 'placeholder' | 'content' | 'choices' | 'i18n'

export interface Choice {
  text: string
  value: unknown
}

export interface TextProposal {
  id: string
  tool: TextTool
  target: TextTarget
  key: TextKey
  place: string
  before: string | null
  after: string
  /** The stored value the proposal replaces; a different value now = changed since asked. */
  base: unknown
  sentence: string
  source: 'rules' | 'ai'
  tone?: 'info' | 'warn'
  choices?: {
    all: Choice[]
    changed: Array<{ value: unknown; before: string; after: string }>
    from: 'field' | 'layout'
  }
  i18n?: { locale: string; label: string; help: string | null }
  score?: { before: number; after: number | null; reasons: string[] }
  terms?: Array<{ term: string; found: string }>
}

export interface TextResult {
  tool: TextTool
  proposals: TextProposal[]
  dropped: number
  terms?: Array<{ term: string; found: string; places: string[] }>
  flagged?: Array<{ place: string; text: string; score: number; reasons: string[] }>
  note?: string
  ai_used: boolean
}

export interface TextLocales {
  locales: string[]
  default_locale: string
  ai_configured: boolean
}
