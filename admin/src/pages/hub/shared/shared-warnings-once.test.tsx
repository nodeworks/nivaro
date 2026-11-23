import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Design round 2 R2-S2: a deployment warning says its point once. The server's sentence shows
// under the plain title only when it carries names the copy cannot (extensions, dropped apps),
// never a restatement of the copy, and never in monospace.

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }
}))

const { warningDetail } = await import('./shared-api')
const { Warnings } = await import('./HubShared')

const REDIS = {
  code: 'REDIS_URL_NOT_APPLIED',
  text: 'A REDIS_URL is stored for this deployment, but its stack has not been applied with it yet. Upgrade the deployment (at the same version to apply it again) so it uses that Redis.'
}

describe('shared deployment warnings', () => {
  it('REDIS_URL_NOT_APPLIED: the title and one what-to-do line, not the server sentence too', () => {
    expect(warningDetail(REDIS)).toBeNull()
    render(<Warnings notes={[REDIS]} />)
    expect(screen.getByText('The stored Redis address is not in use yet')).toBeInTheDocument()
    expect(screen.queryByText(/A REDIS_URL is stored/)).toBeNull()
    expect(screen.getAllByText(/Upgrade the deployment/)).toHaveLength(1)
  })

  it('a warning that names things keeps its names, in plain text', () => {
    const note = { code: 'EXTENSIONS_DIFFER', text: 'not loaded: efp-ops' }
    expect(warningDetail(note)).toBe('not loaded: efp-ops')
    render(<Warnings notes={[note]} />)
    const detail = screen.getByText('not loaded: efp-ops')
    expect(detail.className.split(/\s+/)).not.toContain('font-mono')
  })

  it('an unknown code shows its own sentence as the title, once', () => {
    const note = { code: 'SOMETHING_NEW', text: 'Something new happened.' }
    render(<Warnings notes={[note]} />)
    expect(screen.getAllByText('Something new happened.')).toHaveLength(1)
  })
})
