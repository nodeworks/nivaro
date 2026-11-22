import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SharedTokenReveal } from './SharedTokenReveal'

const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyz'

describe('SharedTokenReveal', () => {
  it('shows the token once with Copy, and the settings block that carries it', () => {
    const onDone = vi.fn()
    render(
      <SharedTokenReveal
        token={TOKEN}
        envBlock={`HUB_SHARED_DEPLOYMENT=s1\nHUB_DEPLOYMENT_TOKEN=${TOKEN}`}
        onDone={onDone}
      />
    )
    expect(screen.getByTestId('shared-token')).toHaveTextContent(TOKEN)
    expect(screen.getByRole('button', { name: 'Copy the token' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy the settings' })).toBeInTheDocument()
    expect(screen.getByText(/shown only this once/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done, I have stored it' }))
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('after a rotation says how long the old token works and what happens to the stack', () => {
    render(
      <SharedTokenReveal
        token={TOKEN}
        envBlock={null}
        rotated={{
          previous_token_valid_until: '2026-11-23T12:00:00.000Z',
          reapply: 'unavailable',
          reapply_reason: null
        }}
        onDone={() => {}}
      />
    )
    expect(screen.getByText(/old token keeps working until/)).toBeInTheDocument()
    expect(screen.getByText(/new token applies with the next upgrade/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy the settings' })).toBeNull()
  })

  it('a rotation the stack could not take yet says why (BUSY) and names the version to re-apply', () => {
    render(
      <SharedTokenReveal
        token={TOKEN}
        envBlock={null}
        version='0.3.210'
        rotated={{ previous_token_valid_until: null, reapply: 'failed', reapply_reason: 'BUSY' }}
        onDone={() => {}}
      />
    )
    expect(screen.getByText(/a move or a placement/)).toBeInTheDocument()
    expect(screen.getByText(/upgrade to 0\.3\.210/)).toBeInTheDocument()
  })
})
