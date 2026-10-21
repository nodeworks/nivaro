/**
 * Layout AI helpers (#2694 #2695 #2676 #2693) under /ai-design/layouts. Admin
 * only. The reads describe forms in plain terms; a proposal stores layout ops
 * for an administrator to review in the layout editor and never changes a
 * layout by itself.
 */
import { type Command, cmd } from '../command.js'
import type { LayoutOp } from './layout-editor.js'

/** A form as an admin reads it: who gets it, settings that are on, sections and fields. */
export interface LayoutDescription {
  id: number
  name: string
  collection: string
  kind: string
  slug: string | null
  default: boolean
  who: string
  record_rule: string | null
  parent_layout_id: number | null
  settings_on: string[]
  groups: Array<{
    key: string
    label: string
    type: string
    parent: string | null
    collapsed?: true
    shows_when?: string
    hidden_for?: string[]
    read_only_for?: string[]
    fields: Array<{
      field: string
      label: string
      width?: string
      required?: true
      readonly?: true
      hidden?: true
      inherited?: true
    }>
  }>
  field_count: number
  not_on_layout: Array<{ field: string; label: string }>
  draft: boolean
  truncated?: true
}

export interface WhichLayoutForm {
  as: string
  record: string | null
  layout: { id: number; name: string } | null
  why: string
  checked: Array<{ layout: string; matched: boolean; why: string }>
}

export interface LayoutFieldExplanation {
  field: string
  label: string
  as: string
  record: string | null
  layout: { id: number; name: string } | null
  verdict: 'shown' | 'shown read-only' | 'hidden' | 'not on the form' | 'cannot open the record'
  reasons: string[]
  draft: boolean
}

export interface LayoutProposal {
  id: string
  layout_id: number
  note: string | null
  status: 'proposed' | 'applied' | 'rejected' | 'expired'
  created_at: string
  proposer: { name: string; via: string }
  ops: LayoutOp[]
  sentences: string[]
  dropped: string[]
  /** Why it would not apply to the layout as it is now, or null. */
  conflict: string | null
}

/** A layout described for a reader (or an assistant). Admin only. */
export function describeLayoutForm(layoutId: number): Command<{ data: LayoutDescription }> {
  return cmd('GET', `/ai-design/layouts/${layoutId}/describe`)
}

/** Which form a record opens with for a role, and why. Admin only. */
export function whichLayoutForm(query: {
  collection: string
  item?: string | number
  role?: string
}): Command<{ data: WhichLayoutForm }> {
  return cmd('GET', '/ai-design/layouts/which-form', query)
}

/** Why a field shows, hides or is read-only for a role on a record. Admin only. */
export function explainLayoutField(query: {
  collection: string
  field: string
  role?: string
  item?: string | number
  layout_id?: number
}): Command<{ data: LayoutFieldExplanation }> {
  return cmd('GET', '/ai-design/layouts/explain-field', query)
}

/**
 * Propose layout ops for an administrator to review in the layout editor.
 * Nothing changes until they apply it. Unknown fields and settings are left
 * out (`dropped`); ops that would not apply are refused with 400.
 */
export function proposeLayoutOps(
  layoutId: number,
  body: { ops: LayoutOp[] | unknown[]; note?: string }
): Command<{
  data: { id: string; status: 'proposed'; changes: string[]; dropped: string[]; note: string }
}> {
  return cmd('POST', `/ai-design/layouts/${layoutId}/proposals`, undefined, body)
}

/** Open proposals for a layout (`status: 'all'` adds applied, rejected and expired). */
export function readLayoutProposals(
  layoutId: number,
  status?: 'all'
): Command<{ data: LayoutProposal[] }> {
  return cmd('GET', `/ai-design/layouts/${layoutId}/proposals`, status ? { status } : undefined)
}

/** Mark a proposal applied (after the editor applied it to its draft) or rejected. */
export function resolveLayoutProposal(
  layoutId: number,
  proposalId: string,
  outcome: 'applied' | 'rejected'
): Command<{ data: { id: string; status: string } }> {
  return cmd('POST', `/ai-design/layouts/${layoutId}/proposals/${proposalId}/resolve`, undefined, {
    outcome
  })
}
