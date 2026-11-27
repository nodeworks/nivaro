import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useAuth } from '@/lib/auth'
import { SectionCard } from '../hub-parts'
import HubDomainsCard from '../security/HubDomainsCard'
import { CertificatesCard } from '../security/HubSecurity'
import { LinkedChange } from './ChangeView'
import { categoriesAt } from './category-homes'
import { NotifyRoutesCard } from './NotifyRoutes'
import { ProviderHome } from './ProviderHome'
import { fetchProviderTypes, providerKeys } from './providers-api'

/**
 * The Hub homes that exist because of what they hold, not because of one feature: Domains &
 * certificates, Channels & routes, Code & pipelines, Cloud accounts and App services. Each shows
 * the Hub's own things of its kind first, then the provider accounts and resources of the same
 * kind (ProviderHome). A change link (`?change=<id>`) opens on any of them.
 */

const useIsAdmin = () => {
  const { user } = useAuth()
  return !!(user as { is_admin?: boolean } | null)?.is_admin
}

function HomePage({
  label,
  isAdmin,
  children
}: {
  label: string
  isAdmin: boolean
  children: ReactNode
}) {
  return (
    <section aria-label={label} className='flex min-h-0 flex-1 flex-col'>
      <div className='relative min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 p-4 sm:p-6'>
          <LinkedChange isAdmin={isAdmin} />
          {children}
        </div>
      </div>
    </section>
  )
}

/** Links to the Hub's own pages of the same kind, so a home never dead-ends. */
function SeeAlso({
  title,
  links
}: {
  title: string
  links: Array<{ to: string; label: string; what: string }>
}) {
  return (
    <SectionCard title={title}>
      <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
        {links.map((l) => (
          <li key={l.to}>
            <Link
              to={l.to}
              className='group flex items-center gap-3 px-4 py-2.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50'
            >
              <span className='min-w-0 flex-1'>
                <span className='block text-[13px] font-medium text-slate-900 dark:text-foreground'>
                  {l.label}
                </span>
                <span className='block text-[12px] text-slate-500 dark:text-muted-foreground'>
                  {l.what}
                </span>
              </span>
              <ArrowRight
                className='h-4 w-4 shrink-0 text-slate-400 group-hover:text-slate-700 dark:text-muted-foreground dark:group-hover:text-foreground'
                aria-hidden
              />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

export function HubDomains() {
  const isAdmin = useIsAdmin()
  return (
    <HomePage label='Domains and certificates' isAdmin={isAdmin}>
      <CertificatesCard isAdmin={isAdmin} />
      <HubDomainsCard />
      <ProviderHome groups={['domains']} isAdmin={isAdmin} idPrefix='hub-home-domains' />
    </HomePage>
  )
}

export function HubMessaging() {
  const isAdmin = useIsAdmin()
  return (
    <HomePage label='Channels and routes' isAdmin={isAdmin}>
      {isAdmin && <NotifyRoutesCard />}
      <ProviderHome groups={['messaging']} isAdmin={isAdmin} idPrefix='hub-home-messaging' />
    </HomePage>
  )
}

export function HubCode() {
  const isAdmin = useIsAdmin()
  return (
    <HomePage label='Code and pipelines' isAdmin={isAdmin}>
      <ProviderHome groups={['code']} isAdmin={isAdmin} idPrefix='hub-home-code' />
      {isAdmin && (
        <SeeAlso
          title='In the Hub'
          links={[
            {
              to: '/hub/drivers',
              label: 'Deploy locations',
              what: 'The GitLab projects and Docker hosts the Hub deploys through.'
            },
            {
              to: '/hub/targets',
              label: 'New app defaults',
              what: 'The group or account a new app’s repository is made in.'
            },
            {
              to: '/hub/extensions',
              label: 'Extensions',
              what: 'Which extension build each environment runs.'
            }
          ]}
        />
      )}
    </HomePage>
  )
}

export function HubCloud() {
  const isAdmin = useIsAdmin()
  return (
    <HomePage label='Cloud accounts' isAdmin={isAdmin}>
      <ProviderHome groups={['hosting']} isAdmin={isAdmin} idPrefix='hub-home-cloud' />
      {isAdmin && (
        <SeeAlso
          title='In the Hub'
          links={[
            {
              to: '/hub/hosts',
              label: 'Hosts & regions',
              what: 'The Docker hosts the Hub runs apps on, and what is on each.'
            },
            {
              to: '/hub/databases',
              label: 'Databases',
              what: 'RDS, Azure SQL and the Hub’s own database servers.'
            },
            {
              to: '/hub/domains',
              label: 'Domains & certificates',
              what: 'Route 53 zones, records and certificates.'
            }
          ]}
        />
      )}
    </HomePage>
  )
}

export function HubServices() {
  const isAdmin = useIsAdmin()
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  return (
    <HomePage label='App services' isAdmin={isAdmin}>
      <ProviderHome
        groups={categoriesAt('/hub/services', types.data)}
        isAdmin={isAdmin}
        idPrefix='hub-home-services'
      />
    </HomePage>
  )
}
