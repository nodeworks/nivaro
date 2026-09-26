import { useState } from 'react'
import { useItemEditAuth } from '../../context'
import { cn } from '../../lib/utils'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { DelegationCard } from './DelegationCard'
import {
  AccessCard,
  ApiTokenCard,
  SessionsCard,
  SuspensionBanner,
  UserDirectoryCard,
  UserScopesCard
} from './PersonAccess'
import { ActivityFeedCard, JourneyCard, SignInsCard, StatsCard } from './PersonActivity'
import { ForceReloadCard, MergeCard, OffboardingCard } from './PersonAdminTools'
import { WhyCard, WorkingOnCard } from './PersonExtras'
import { PersonHeader } from './PersonHeader'
import { AboutCard, AvailabilityCard, PeopleCard, ResponsibilitiesCard } from './PersonOverview'
import { useInvalidatePerson, usePersonProfile } from './types'

export type PersonProfileTab = 'overview' | 'access' | 'activity' | 'tools'

/**
 * Someone else's page. A colleague gets the slim read: who they are, how to
 * reach them, whether they are around and who covers them, what they own.
 * An admin gets the same page plus three tabs — Access, Activity, Admin
 * tools — that hold every control the old admin-only user editor had.
 */
export function PersonProfile({
  userId,
  className,
  initialTab = 'overview'
}: {
  userId: string
  className?: string
  initialTab?: PersonProfileTab
}) {
  const auth = useItemEditAuth()
  const isAdmin = !!auth?.isAdmin
  const { data: profile, isLoading, isError } = usePersonProfile(userId)
  const invalidate = useInvalidatePerson(userId)
  const [tab, setTab] = useState<PersonProfileTab>(initialTab)

  if (isLoading || (!profile && !isError)) return <PersonSkeleton className={className} />
  if (!profile) {
    return (
      <div
        className={cn(
          'rounded-lg border border-slate-200 bg-white p-8 text-center dark:border-border dark:bg-card',
          className
        )}
        data-person-missing
      >
        <p className='text-[14px] font-semibold text-slate-800 dark:text-slate-100'>
          No such person
        </p>
        <p className='mt-1 text-[12.5px] text-slate-500 dark:text-slate-400'>
          The account may have been removed, or you may not have access to it.
        </p>
      </div>
    )
  }

  const overview = (
    <div className='grid gap-4 lg:grid-cols-2'>
      <div className='space-y-4'>
        <AboutCard profile={profile} isAdmin={isAdmin} />
        <WorkingOnCard profile={profile} />
        <PeopleCard profile={profile} />
      </div>
      <div className='space-y-4'>
        {isAdmin ? (
          <DelegationCard
            user={{
              id: profile.id,
              email: profile.email,
              first_name: profile.first_name,
              last_name: profile.last_name,
              role: profile.role_id,
              status: profile.status,
              is_out_of_office: profile.is_out_of_office,
              delegate_id: profile.delegate?.id ?? null,
              delegate_expires_at: profile.delegate?.expires_at ?? null,
              ooo_start: profile.ooo_start,
              ooo_end: profile.ooo_end
            }}
            forUser={{ id: profile.id, firstName: profile.first_name ?? profile.name }}
            coversFor={profile.covers_for}
            onSaved={invalidate}
          />
        ) : (
          <AvailabilityCard profile={profile} />
        )}
        <ResponsibilitiesCard profile={profile} isAdmin={isAdmin} />
      </div>
    </div>
  )

  return (
    <div className={cn('flex flex-col gap-4', className)} data-nvr-person={profile.id}>
      <PersonHeader profile={profile} isAdmin={isAdmin} />
      {isAdmin && <SuspensionBanner profile={profile} />}
      {!isAdmin ? (
        overview
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as PersonProfileTab)}>
          <TabsList
            className='h-9 w-full justify-start gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-border dark:bg-card'
            data-person-tabs
          >
            {(
              [
                ['overview', 'Overview'],
                ['access', 'Access'],
                ['activity', 'Activity'],
                ['tools', 'Admin tools']
              ] as Array<[PersonProfileTab, string]>
            ).map(([id, label]) => (
              <TabsTrigger
                key={id}
                value={id}
                data-person-tab={id}
                className='h-7 rounded-md px-3 text-[12px] font-medium text-slate-500 data-[state=active]:bg-[#00ceff1a] data-[state=active]:text-nvr-navy data-[state=active]:shadow-none dark:text-slate-400 dark:data-[state=active]:text-nvr-cyan'
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value='overview' className='mt-4 focus-visible:outline-none'>
            {overview}
          </TabsContent>
          <TabsContent value='access' className='mt-4 focus-visible:outline-none'>
            <div className='grid gap-4 lg:grid-cols-2'>
              <div className='space-y-4'>
                <AccessCard profile={profile} />
                <UserScopesCard userId={profile.id} />
                <WhyCard profile={profile} />
              </div>
              <div className='space-y-4'>
                <UserDirectoryCard profile={profile} />
                <SessionsCard userId={profile.id} />
                <ApiTokenCard profile={profile} />
              </div>
            </div>
          </TabsContent>
          <TabsContent value='activity' className='mt-4 focus-visible:outline-none'>
            <div className='grid gap-4 lg:grid-cols-2'>
              <div className='space-y-4'>
                <StatsCard userId={profile.id} />
                <ActivityFeedCard userId={profile.id} />
              </div>
              <div className='space-y-4'>
                <SignInsCard profile={profile} />
                <JourneyCard userId={profile.id} />
              </div>
            </div>
          </TabsContent>
          <TabsContent value='tools' className='mt-4 focus-visible:outline-none'>
            <div className='grid gap-4 lg:grid-cols-2'>
              <div className='space-y-4'>
                <ForceReloadCard profile={profile} />
                <MergeCard profile={profile} />
              </div>
              <div className='space-y-4'>
                <OffboardingCard profile={profile} />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

function PersonSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('flex animate-pulse flex-col gap-4', className)} aria-busy='true'>
      <div className='flex items-center gap-5 rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        <div className='h-[76px] w-[76px] rounded-full bg-slate-100 dark:bg-muted' />
        <div className='flex-1 space-y-2.5'>
          <div className='h-5 w-48 rounded bg-slate-100 dark:bg-muted' />
          <div className='h-3.5 w-72 max-w-full rounded bg-slate-100 dark:bg-muted' />
          <div className='h-3.5 w-56 max-w-full rounded bg-slate-100 dark:bg-muted' />
        </div>
      </div>
      <div className='grid gap-4 lg:grid-cols-2'>
        <div className='h-56 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card' />
        <div className='h-56 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card' />
      </div>
    </div>
  )
}
