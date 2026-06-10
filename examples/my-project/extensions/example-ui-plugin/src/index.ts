import type { ExtensionContext } from '../../../../src/extensions/loader.js'

export async function register({ logger }: ExtensionContext) {
  logger.info('Example UI plugin API side loaded')
}
