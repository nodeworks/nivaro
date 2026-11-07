import { describe, expect, it } from 'vitest'
import { type SaveNotice, saveClosingMessage, saveLeftWorkStaged } from './save-outcome'

const base: SaveNotice = { hidden: null, linkProblems: [] }
const edit = { isNew: false, noun: 'Workflow' }

describe('saveClosingMessage', () => {
  it('a plain save says Changes saved / Record created', () => {
    expect(saveClosingMessage(base, edit)).toEqual({ kind: 'success', text: 'Changes saved' })
    expect(saveClosingMessage(base, { ...edit, isNew: true })).toEqual({
      kind: 'success',
      text: 'Record created'
    })
  })

  it('M29 (army 6): a change waiting on its reason is never "Changes saved"', () => {
    const notice = { ...base, reasonWaiting: true }
    const msg = saveClosingMessage(notice, edit)
    expect(msg?.kind).toBe('warning')
    expect(msg?.text).toBe('Not saved yet — give a reason for the change to finish saving')
    expect(msg?.text).not.toMatch(/Changes saved/)
    expect(saveLeftWorkStaged(notice)).toBe(true)
  })

  it('a refused line wins over a waiting reason', () => {
    const msg = saveClosingMessage(
      { ...base, childFailed: true, reasonWaiting: true, childErrors: ['Line 1: too big'] },
      edit
    )
    expect(msg).toEqual({
      kind: 'error',
      text: 'Not everything saved — Line 1: too big',
      duration: 20_000
    })
  })

  it('a refused line create named only in linkProblems gets no second toast', () => {
    expect(
      saveClosingMessage({ ...base, childFailed: true, linkProblems: ['Line 2: refused'] }, edit)
    ).toBeNull()
  })

  it('L43: a save that sent nothing says so', () => {
    expect(saveClosingMessage({ ...base, noFieldWrite: true, onlyMain: true }, edit)).toEqual({
      kind: 'plain',
      text: 'Nothing to save — no changes'
    })
  })

  it('line conflicts, kept-theirs and hidden records keep their own wording', () => {
    expect(saveClosingMessage({ ...base, lineConflicts: 1 }, edit)?.text).toBe(
      'Saved, except 1 line someone else changed — pick which value wins'
    )
    expect(
      saveClosingMessage({ ...base, keptTheirs: 2, noFieldWrite: true, onlyMain: true }, edit)?.text
    ).toBe('Kept the newer values — nothing of yours left to save')
    expect(saveClosingMessage({ ...base, hidden: { reason: 'scope' } }, edit)?.text).toBe(
      'Saved, but this workflow is now outside what you can see (scope).'
    )
  })

  it('only a refused line or a waiting reason leaves work staged', () => {
    expect(saveLeftWorkStaged(base)).toBe(false)
    expect(saveLeftWorkStaged({ ...base, lineConflicts: 1 })).toBe(false)
    expect(saveLeftWorkStaged({ ...base, childFailed: true })).toBe(true)
  })
})
