import { describe, expect, it, vi } from 'vitest'
import {
  registerExtensionSignal,
  registerExtensionSignalAction
} from '../../../extensions/signal-registration.js'
import { getIntegrationSignal } from '../../../services/integration-signals.js'

const signal = (id: string) => ({
  id,
  label: 'L',
  description: '',
  tab: 'pushes',
  severity: 'warn' as const,
  thresholds: [],
  evaluate: async () => ({ count: 0, rows: [] })
})

describe('registerExtensionSignal', () => {
  it('an invalid id is logged, never an unhandled rejection that takes the API down', async () => {
    const logger = { error: vi.fn() }
    await expect(
      registerExtensionSignal(signal('Not A Valid Id'), 'acme-sync', logger)
    ).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalledTimes(1)
    const [obj, msg] = logger.error.mock.calls[0]
    expect(obj).toMatchObject({ extension: 'acme-sync', signal: 'Not A Valid Id' })
    expect((obj as { err: Error }).err).toBeInstanceOf(Error)
    expect(msg).toBe('registerSignal failed')
  })

  it('a valid signal registers under its owner', async () => {
    const logger = { error: vi.fn() }
    await registerExtensionSignal(signal('acme-sync:lag'), 'acme-sync', logger)
    expect(getIntegrationSignal('acme-sync:lag')?.label).toBe('L')
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('registerExtensionSignalAction', () => {
  it('never rejects', async () => {
    const logger = { error: vi.fn() }
    await expect(
      registerExtensionSignalAction(
        { id: 'acme-sync:fix', label: 'Fix', run: async () => [] },
        'acme-sync',
        logger
      )
    ).resolves.toBeUndefined()
  })
})
