// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  arrowsBelongElsewhere,
  isNewTabClick,
  notificationPeekTarget,
  peekable,
  peekDecision,
  peekStep
} from './record-peek'

describe('record peek decisions', () => {
  it('a modified or middle click asks for a new tab', () => {
    expect(isNewTabClick({ metaKey: true })).toBe(true)
    expect(isNewTabClick({ ctrlKey: true })).toBe(true)
    expect(isNewTabClick({ shiftKey: true })).toBe(true)
    expect(isNewTabClick({ button: 1 })).toBe(true)
    expect(isNewTabClick({ button: 0 })).toBe(false)
    expect(isNewTabClick(null)).toBe(false)
  })

  it('peeks business records only, and only when the host has a sheet', () => {
    expect(peekable('workflows')).toBe(true)
    expect(peekable('nivaro_users')).toBe(false)
    expect(peekable('directus_files')).toBe(false)
    expect(peekable('__chat__')).toBe(false)
    expect(peekDecision({ button: 0 }, true, 'workflows')).toBe('peek')
    expect(peekDecision({ button: 0 }, false, 'workflows')).toBe('navigate')
    expect(peekDecision({ button: 0 }, true, 'nivaro_tasks')).toBe('navigate')
    expect(peekDecision({ metaKey: true }, true, 'workflows')).toBe('new-tab')
  })

  it('arrow steps stop at the ends', () => {
    expect(peekStep(0, 3, 'ArrowDown')).toBe(1)
    expect(peekStep(2, 3, 'ArrowDown')).toBeNull()
    expect(peekStep(0, 3, 'ArrowUp')).toBeNull()
    expect(peekStep(2, 3, 'ArrowUp')).toBe(1)
    expect(peekStep(-1, 3, 'ArrowDown')).toBeNull()
    expect(peekStep(1, 3, 'Enter')).toBeNull()
  })

  it('arrow keys in a field or menu are not the sheet’s', () => {
    const input = document.createElement('input')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.appendChild(item)
    const plain = document.createElement('button')
    document.body.append(input, menu, plain)
    expect(arrowsBelongElsewhere(input)).toBe(true)
    expect(arrowsBelongElsewhere(item)).toBe(true)
    expect(arrowsBelongElsewhere(plain)).toBe(false)
    expect(arrowsBelongElsewhere(null)).toBe(false)
  })
})

describe('notificationPeekTarget', () => {
  it('opens a plain record target in the sheet', () => {
    expect(
      notificationPeekTarget({
        subject: 'PO 12 approved',
        target: { kind: 'record', collection: 'workflows', id: 12 }
      })
    ).toEqual({ collection: 'workflows', itemId: '12', title: 'PO 12 approved' })
    expect(notificationPeekTarget({ collection: 'workflows', item: '7' })?.itemId).toBe('7')
  })

  it('keeps navigating for deep links and non-record kinds', () => {
    expect(
      notificationPeekTarget({
        target: { kind: 'record', collection: 'workflows', id: 1, focus: 'comment:9' }
      })
    ).toBeNull()
    expect(
      notificationPeekTarget({
        target: { kind: 'record', collection: 'workflows', id: 1, tab: 'x' }
      })
    ).toBeNull()
    expect(notificationPeekTarget({ target: { kind: 'queue', id: 3 } })).toBeNull()
    expect(notificationPeekTarget({ collection: 'nivaro_tasks', item: '3' })).toBeNull()
    expect(notificationPeekTarget({ collection: 'workflows', item: '' })).toBeNull()
  })
})
