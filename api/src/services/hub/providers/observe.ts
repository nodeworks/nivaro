import type { HubActor } from './engine/contract.js'
import { ResourceChangeError } from './engine/contract.js'
import type { ListPage, ResourceScope } from './types.js'

/**
 * Drift, unmanaged and adopt (Task 4 owns the bodies). Task 2's routes call these two
 * functions; until Task 4 replaces them they answer 501 NOT_IMPLEMENTED.
 */

/** Everything of `type` the connection can see that the Hub does not manage yet. */
export async function listUnmanaged(
  _connectionId: number,
  _type: string,
  _cursor: string | null | undefined,
  _actor: HubActor
): Promise<ListPage> {
  throw new ResourceChangeError('NOT_IMPLEMENTED', 'Listing unmanaged resources is not built yet.')
}

export interface AdoptInput {
  type: string
  externalId: string
  scope: ResourceScope
  appId?: number
  environmentId?: number
}

/** Binds an existing provider resource to a scope (no provider write). Returns the new row id. */
export async function adoptResource(
  _connectionId: number,
  _input: AdoptInput,
  _actor: HubActor
): Promise<unknown> {
  throw new ResourceChangeError('NOT_IMPLEMENTED', 'Adopting a resource is not built yet.')
}
