// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PinnedSection } from './PinnedSection'
import { allByRole, cleanup, click, getByRole, getByText, mount, queryByText } from './test-kit'
import type { DirectoryCollection as Collection } from './types'

afterEach(cleanup)

const col = (collection: string, display_name: string) =>
  ({
    collection,
    display_name,
    group: null,
    hidden: false,
    singleton: false,
    sort: null,
    color: null,
    icon: null,
    note: null
  }) as Collection

const cols = [col('workflows', 'Workflows'), col('invoices', 'Invoices'), col('vendors', 'Vendors')]

type Props = ComponentProps<typeof PinnedSection>

function renderSection(over: Partial<Props> = {}) {
  const props: Props = {
    cols,
    isAdmin: true,
    status: 'ready',
    onReorder: vi.fn(),
    collapsed: false,
    onToggle: vi.fn(),
    renderRow: (c, opts) => (
      <div data-row={c.collection}>
        {opts.handle}
        {c.display_name}
        {opts.onMoveUp && (
          <button type='button' onClick={opts.onMoveUp}>
            up {c.collection}
          </button>
        )}
        {opts.onMoveDown && (
          <button type='button' onClick={opts.onMoveDown}>
            down {c.collection}
          </button>
        )}
      </div>
    ),
    ...over
  }
  const utils = mount(<PinnedSection {...props} />)
  return { ...utils, props }
}

describe('PinnedSection', () => {
  it('lists the pins in order under a "Pinned" heading that says it is for everyone', () => {
    const { container } = renderSection()
    expect(getByText('Pinned')).toBeTruthy()
    expect(getByText('For everyone')).toBeTruthy()
    expect(
      [...container.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'))
    ).toEqual(['workflows', 'invoices', 'vendors'])
  })

  it('gives admins a drag handle and move up/down that stop at the ends', () => {
    const { props } = renderSection()
    expect(allByRole('button', /^Drag to reorder/)).toHaveLength(3)
    expect(queryByText('up workflows')).toBeNull()
    expect(queryByText('down vendors')).toBeNull()
    click(getByText('down workflows'))
    expect(props.onReorder).toHaveBeenCalledWith(['invoices', 'workflows', 'vendors'])
    click(getByText('up vendors'))
    expect(props.onReorder).toHaveBeenLastCalledWith(['workflows', 'vendors', 'invoices'])
  })

  it('is read-only for everyone else', () => {
    renderSection({ isAdmin: false })
    expect(allByRole('button', /Drag to reorder/)).toHaveLength(0)
    expect(queryByText(/^up |^down /)).toBeNull()
    expect(getByText('Workflows')).toBeTruthy()
  })

  it('teaches admins when nothing is pinned', () => {
    renderSection({ cols: [] })
    expect(getByText('Pin collections everyone should see first')).toBeTruthy()
  })

  it('shows nothing to non-admins when nothing is pinned', () => {
    const { container } = renderSection({ cols: [], isAdmin: false })
    expect(container.innerHTML).toBe('')
  })

  it('says it could not load, with a way to try again', () => {
    const onRetry = vi.fn()
    renderSection({
      cols: [],
      status: 'error',
      error: { response: { status: 503, data: { error: 'Service Unavailable' } } },
      onRetry
    })
    click(getByRole('button', /try again/i))
    expect(onRetry).toHaveBeenCalled()
  })

  it('folds away when collapsed', () => {
    const { container } = renderSection({ collapsed: true })
    expect(container.querySelectorAll('[data-row]')).toHaveLength(0)
    expect(getByText('Pinned')).toBeTruthy()
  })
})
