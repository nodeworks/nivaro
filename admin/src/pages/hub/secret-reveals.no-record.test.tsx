import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { REPLAY_BLOCK_SELECTOR } from '../../../../packages/shared/src/lib/replay-masking'

// Final review I-1: a secret the Hub shows once is plain text, and session replay masks only
// inputs. Every such box must sit under the replay block selector (rrweb records a same-size
// blank box) and under `.nvr-no-record` (the Report-a-problem screenshot blanks it), so the value
// never reaches replay storage or a screenshot.

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }
}))

const { SharedTokenReveal } = await import('./shared/SharedTokenReveal')
const { DockerDriverFields } = await import('./docker/DockerDriverFields')
const { OneTimeSecret } = await import('./signin/HubEnvSigninPanel')
const { EMPTY_DOCKER_DRAFT } = await import('./docker/docker-api')

const TOKEN = 'tok_0123456789abcdefghijklmnopqrstuvwxyz'

/** Every element whose own text holds the secret is inside both masks. */
function expectUnrecorded(secret: string) {
  const holders = Array.from(document.body.querySelectorAll('*')).filter((el) =>
    Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.includes(secret))
  )
  expect(holders.length).toBeGreaterThan(0)
  for (const el of holders) {
    expect(el.closest(REPLAY_BLOCK_SELECTOR)).not.toBeNull()
    expect(el.closest('[data-replay-block]')).not.toBeNull()
    expect(el.closest('.nvr-no-record')).not.toBeNull()
  }
}

describe('secrets shown once are never recorded', () => {
  it('the shared deployment token and the settings block that carries it', () => {
    render(
      <SharedTokenReveal
        token={TOKEN}
        envBlock={`HUB_SHARED_DEPLOYMENT=s1\nHUB_DEPLOYMENT_TOKEN=${TOKEN}`}
        onDone={() => {}}
      />
    )
    expect(screen.getByTestId('shared-token')).toHaveTextContent(TOKEN)
    expectUnrecorded(TOKEN)
  })

  it('a generated Hub agent token', () => {
    render(
      <DockerDriverFields
        idPrefix='t'
        draft={EMPTY_DOCKER_DRAFT}
        onChange={() => {}}
        token={TOKEN}
        onTokenChange={() => {}}
        tokenStored={false}
        fresh={TOKEN}
        onFresh={() => {}}
        tried={false}
      />
    )
    expect(screen.getByTestId('generated-token')).toHaveTextContent(TOKEN)
    expectUnrecorded(TOKEN)
  })

  it("a sign-in client's secret and the settings lines that carry it", () => {
    render(
      <OneTimeSecret
        minted={{
          lines: {
            HUB_URL: 'https://hub.example.com',
            HUB_CLIENT_ID: 'hubc_1',
            HUB_IDP_AUDIENCE: 'aud-1'
          },
          secret: TOKEN,
          clientId: 'hubc_1'
        }}
        onClose={() => {}}
      />
    )
    expect(screen.getByTestId('hub-env-lines')).toHaveTextContent(TOKEN)
    expectUnrecorded(TOKEN)
  })
})
