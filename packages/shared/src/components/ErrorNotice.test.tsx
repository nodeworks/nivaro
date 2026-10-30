// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorNotice } from './ErrorNotice'
import { ErrorSurface } from './ErrorSurface'
import { LoadErrorNote } from './LoadErrorNote'
import { QueryErrorState } from './QueryErrorState'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const crash = Object.assign(new Error('Internal Server Error'), {
  status: 500,
  requestId: 'req-77',
  response: {
    statusCode: 500,
    error: 'Internal Server Error',
    message: "Cannot read properties of undefined (reading 'zone')"
  }
})

let cleanup: (() => void) | null = null
function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(node))
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  return host
}
afterEach(() => cleanup?.())

describe('ErrorNotice', () => {
  it('says what happened and what to do, with one button and the reference tucked away', () => {
    const onRetry = vi.fn()
    const host = mount(<ErrorNotice error={crash} what='the budget' onRetry={onRetry} />)
    const alert = host.querySelector('[role="alert"]') as HTMLElement
    expect(alert.textContent).toContain('Couldn’t load the budget')
    expect(alert.textContent).toContain('If it keeps happening, ask for help.')
    // Nothing raw outside the collapsed details.
    const details = host.querySelector('details[data-error-details]') as HTMLDetailsElement
    expect(details.open).toBe(false)
    const outside = alert.textContent?.replace(details.textContent ?? '', '') ?? ''
    expect(outside).not.toMatch(/500|req-77|Cannot read|HTTP/)
    expect(details.textContent).toContain('req-77')
    const buttons = host.querySelectorAll('[data-error-action]')
    expect(buttons).toHaveLength(1)
    act(() => (buttons[0] as HTMLButtonElement).click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('signed out offers Sign in again', () => {
    const host = mount(<ErrorNotice error={{ status: 401, response: { error: 'Unauthorized' } }} />)
    expect(host.querySelector('[data-error-action]')?.textContent).toBe('Sign in again')
    expect(host.textContent).toContain('You’ve been signed out')
  })

  it('a validation refusal has no button: the person fixes the form', () => {
    const host = mount(
      <ErrorNotice
        error={{ status: 422, response: { error: 'Some values need fixing', fields: ['zone'] } }}
      />
    )
    expect(host.querySelector('[data-error-action]')).toBeNull()
    expect(host.textContent).toContain('Check Zone, then try again.')
  })
})

describe('the shared error surfaces read through it', () => {
  it('QueryErrorState', () => {
    const host = mount(<QueryErrorState error={crash} what='files' onRetry={() => {}} />)
    expect(host.textContent).toContain('Couldn’t load files')
    expect(host.querySelector('[data-error-action="retry"]')).not.toBeNull()
  })

  it('LoadErrorNote never shows a raw message', () => {
    const host = mount(<LoadErrorNote message='Request failed with status code 500' />)
    expect(host.textContent).toContain('Something went wrong on the server')
    expect(host.textContent).not.toMatch(/status code/)
  })

  it('ErrorSurface hides a raw detail behind Details for support', () => {
    const host = mount(
      <ErrorSurface
        variant='500'
        detail={"TypeError: Cannot read properties of null (reading 'id')"}
      />
    )
    const details = host.querySelector('details') as HTMLDetailsElement
    expect(details).not.toBeNull()
    expect(details.open).toBe(false)
    const outside = host.textContent?.replace(details.textContent ?? '', '') ?? ''
    expect(outside).not.toMatch(/TypeError|Cannot read/)
  })
})
