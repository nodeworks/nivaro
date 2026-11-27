import { describe, expect, it } from 'vitest'
import { auth0Provider } from '../../../services/hub/providers/auth0/index.js'
import { expoAdapter } from '../../../services/hub/providers/expo/index.js'
import { githubAdapter } from '../../../services/hub/providers/github/index.js'
import { fieldWords, typedName } from '../../../services/hub/providers/plan-words.js'
import type {
  DesiredResource,
  Observed,
  ProviderContext
} from '../../../services/hub/providers/types.js'
import { vercelAdapter } from '../../../services/hub/providers/vercel/index.js'

// Task 3b H: every adapter's plan reason names a resource type by its label ("Create VPC x",
// "Create Vercel project web"), and the fields that change by their labels — never a type key
// ("github.repository"), a lower-cased key word ("vpc") or a field key ("enable_dns_support").

const ctx = {} as ProviderContext

const want = (type: string, fields: Record<string, unknown>): DesiredResource => ({
  resourceId: 7,
  type,
  externalId: null,
  scope: 'app',
  appId: 1,
  environmentId: 2,
  fields,
  refs: {},
  tags: {}
})

const seen = (type: string, name: string, fields: Record<string, unknown>): Observed => ({
  type,
  externalId: `${type}-1`,
  name,
  fields,
  tags: {}
})

describe('plan words', () => {
  it('typedName and fieldWords', () => {
    expect(typedName('VPC', 'hub-shared-2')).toBe('VPC hub-shared-2')
    expect(typedName('VPC', '  ')).toBe('VPC')
    const fields = [
      { key: 'enable_dns_support', label: 'DNS resolution', kind: 'boolean' as const },
      { key: 'rules', label: 'Rules', kind: 'list' as const }
    ]
    expect(fieldWords(fields, ['enable_dns_support', { field: 'rules.0.port' }, 'rules'])).toBe(
      'DNS resolution, Rules'
    )
    expect(fieldWords(fields, ['some_key'])).toBe('some key')
  })
})

describe('every adapter names types by their label', () => {
  const noKey = (reason: string) => {
    expect(reason).not.toMatch(/\b(github|vercel|auth0|expo|aws)\.[a-z_]+/)
  }

  it('GitHub', () => {
    const [op] = githubAdapter.plan(ctx, want('github.repository', { name: 'web' }), null)
    expect(op.reason).toBe('Create GitHub repository web.')
    noKey(op.reason)
  })

  it('Vercel', () => {
    const [create] = vercelAdapter.plan(ctx, want('vercel.project', { name: 'web' }), null)
    expect(create.reason).toBe('Create Vercel project web.')
    const [update] = vercelAdapter.plan(
      ctx,
      want('vercel.project', { name: 'web', framework: 'vite' }),
      seen('vercel.project', 'web', { name: 'web', framework: 'nextjs' })
    )
    expect(update.reason).toBe('Change Framework preset on Vercel project web.')
  })

  it('Auth0', () => {
    const [create] = auth0Provider.plan(ctx, want('auth0.application', { name: 'Portal' }), null)
    expect(create.reason).toMatch(/^Create Auth0 application Portal /)
    const [del] = auth0Provider.plan(ctx, null, seen('auth0.application', 'Portal', {}))
    expect(del.reason).toBe('Delete Auth0 application Portal.')
    noKey(create.reason)
  })

  it('Expo', () => {
    const [create] = expoAdapter.plan(ctx, want('expo.branch', { name: 'main' }), null)
    expect(create.reason).toMatch(/^Create Update branch main\. /)
    const [del] = expoAdapter.plan(ctx, null, seen('expo.channel', 'production', {}))
    expect(del.reason).toBe('Delete Update channel production.')
    noKey(create.reason)
  })
})
