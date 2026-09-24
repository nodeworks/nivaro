/**
 * Extension signal registration, made safe to fire and forget. The registry
 * is imported lazily (it would otherwise pull the whole signals stack into
 * the loader at boot) and `registerIntegrationSignal` THROWS on a malformed
 * id — un-caught, that rejection would surface as an unhandled rejection and
 * could take the API down over one extension's typo. It is logged against the
 * extension instead; the rest of the extension keeps loading.
 */
import type { IntegrationSignal, SignalActionHandler } from '../services/integration-signals.js'

interface ErrorLogger {
  error(obj: Record<string, unknown>, msg?: string): void
}

export function registerExtensionSignal(
  def: IntegrationSignal,
  owner: string,
  logger: ErrorLogger
): Promise<void> {
  return import('../services/integration-signals.js')
    .then(({ registerIntegrationSignal }) => registerIntegrationSignal(def, owner))
    .catch((err: unknown) => {
      logger.error({ err, extension: owner, signal: def?.id }, 'registerSignal failed')
    })
}

export function registerExtensionSignalAction(
  def: SignalActionHandler,
  owner: string,
  logger: ErrorLogger
): Promise<void> {
  return import('../services/integration-signals.js')
    .then(({ registerIntegrationSignalAction }) => registerIntegrationSignalAction(def, owner))
    .catch((err: unknown) => {
      logger.error({ err, extension: owner, action: def?.id }, 'registerSignalAction failed')
    })
}
