/** Transition comments that are machine provenance (state merges, legacy
 *  syncs, auto moves), never a person's words — not quoted to people. One
 *  definition for the transition mail and the "Latest comment" block. */
export const MACHINE_TRANSITION_COMMENT =
  /^(auto: |state-merge|legacy-|reforecast|linx-state-sync|instance-migration|natural-key upsert|import:)/i
