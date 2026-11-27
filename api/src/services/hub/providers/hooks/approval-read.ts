// Task 11c: while a promotion is planned, the GitHub run a github_actions approval step would
// approve is read (READ ONLY — nothing is written at GitHub here). The plan names that run and its
// head commit, both bound in the promotion's plan hash and sent to the approval op, which approves
// nothing else.
import { makeProviderContext } from '../context.js'
import { findWaitingRun, type WaitingRun } from '../github/resources.js'
import { ensureCoreProviders } from '../index.js'
import { getProvider } from '../registry.js'
import { openConnectionSecrets, readConnection } from '../store.js'

export type { WaitingRun }

export interface WaitingRunQuery {
  connectionId: number
  /** The workflow's external id, owner/repo#file.yml. */
  workflow: string
  environment: string
  branch: string
}

export type WaitingRunReader = (q: WaitingRunQuery) => Promise<WaitingRun | null>

/** The live reader: the workflow's own GitHub connection, a 15 s budget. */
export const readWaitingRun: WaitingRunReader = async (q) => {
  const row = await readConnection(q.connectionId)
  if (!row || row.provider !== 'github')
    throw new Error('The workflow’s GitHub connection is gone.')
  ensureCoreProviders()
  const adapter = getProvider('github')
  if (!adapter) throw new Error('The GitHub provider is not available on this Hub.')
  const ctx = makeProviderContext({
    adapter,
    connectionId: row.id,
    config: row.config,
    secrets: await openConnectionSecrets(row),
    fetch: { timeoutMs: 15_000 }
  })
  return findWaitingRun(ctx, q.workflow, q.environment, q.branch)
}
