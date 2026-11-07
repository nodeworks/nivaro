// What a record-form save tells the person when it settles. Leaf module — no
// React, unit-tested directly (save-outcome.test.ts).

/** What a save did that its steps alone do not say (written by saveMut, read
 *  by onSuccess for the closing message). */
export type SaveNotice = {
  hidden: { reason: string | null } | null
  linkProblems: string[]
  /** Lines whose staged edit met someone else's newer save (a10-3). */
  lineConflicts?: number
  /** Header fields the person left on THEIRS in the mid-air dialog (b09). */
  keptTheirs?: number
  /** The record itself got no PATCH (no field left to write). */
  noFieldWrite?: boolean
  /** The save had no step beyond the record's own fields. */
  onlyMain?: boolean
  /** A line (child row) write was refused: what is staged stays staged,
   *  the form stays dirty and no green "Changes saved" (army5 b02-N7). */
  childFailed?: boolean
  /** "Line 1: <refusal>" for each refused line edit / delete. */
  childErrors?: string[]
  /** A write was refused for want of a change reason (422 CHANGE_REASON_REQUIRED):
   *  the reason dialog is open, what needs the reason is still staged (army6 M29). */
  reasonWaiting?: boolean
}

export type SaveClosingMessage = {
  kind: 'success' | 'warning' | 'error' | 'plain'
  text: string
  duration?: number
}

/** The save left work staged: the form stays dirty and its recovery draft stays. */
export function saveLeftWorkStaged(notice: SaveNotice): boolean {
  return notice.childFailed === true || notice.reasonWaiting === true
}

/**
 * The one closing message of a save that settled. `noun` = the collection's
 * singular, as people say it ("Workflow"). Never a green "Changes saved" over
 * work that did not land: a refused line, a change still waiting on its reason
 * (army6 M29), or a save that sent nothing (army6 L43).
 */
export function saveClosingMessage(
  notice: SaveNotice,
  opts: { isNew: boolean; noun: string }
): SaveClosingMessage | null {
  const { isNew } = opts
  const noun = opts.noun.toLowerCase()
  if (notice.childFailed) {
    // Line creates name their refusals in linkProblems (a toast of their own).
    const errs = notice.childErrors ?? []
    if (errs.length === 0 && notice.linkProblems.length > 0) return null
    return {
      kind: 'error',
      text:
        errs.length > 0
          ? `Not everything saved — ${errs.join(' · ')}`
          : 'Not everything saved — some lines did not save',
      duration: 20_000
    }
  }
  if (notice.reasonWaiting) {
    return {
      kind: 'warning',
      text: 'Not saved yet — give a reason for the change to finish saving',
      duration: 10_000
    }
  }
  if (notice.hidden) {
    const why = notice.hidden.reason ? ` (${notice.hidden.reason})` : ''
    return {
      kind: 'warning',
      text: isNew
        ? `The new ${noun} was created, but it’s outside what you can see${why}.`
        : `Saved, but this ${noun} is now outside what you can see${why}.`,
      duration: 15_000
    }
  }
  if (notice.lineConflicts) {
    // The chooser is open: the rest saved, these lines wait on a pick.
    const n = notice.lineConflicts
    return {
      kind: 'warning',
      text: `Saved, except ${n} ${n === 1 ? 'row' : 'rows'} someone else changed — pick which value wins`,
      duration: 10_000
    }
  }
  if (!isNew && notice.keptTheirs) {
    // The mid-air dialog's retry: say what happened to the fields the person
    // left on THEIRS — never a plain "Changes saved" when nothing of theirs
    // was written over (army5 b09).
    const n = notice.keptTheirs
    return {
      kind: 'success',
      text:
        notice.noFieldWrite && notice.onlyMain
          ? `Kept the newer ${n === 1 ? 'value' : 'values'} — nothing of yours left to save`
          : `Changes saved — kept the newer ${n === 1 ? 'value' : 'values'} for ${n} ${n === 1 ? 'field' : 'fields'}`
    }
  }
  // L43 (army 6): no request was sent — never "Changes saved".
  if (!isNew && notice.noFieldWrite && notice.onlyMain)
    return { kind: 'plain', text: 'Nothing to save — no changes' }
  return { kind: 'success', text: isNew ? 'Record created' : 'Changes saved' }
}
