import { useState } from 'react'
import { useItemEditAuth } from '../../context'
import { cn } from '../../lib/utils'
import { PermissionSummaryCard } from '../access/PermissionSummary'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { DayTimelineCard } from './DayTimeline'
import { DelegationCard } from './DelegationCard'
import { MyDefaultsCard } from './MyDefaultsCard'
import {
  AccessCard,
  ApiTokenCard,
  SessionsCard,
  SuspensionBanner,
  UserDirectoryCard,
  UserScopesCard
} from './PersonAccess'
import { AccessSummaryCard } from './PersonAccessSummary'
import { ActivityFeedCard, JourneyCard, SignInsCard, StatsCard } from './PersonActivity'
import {
  ForceReloadCard,
  MergeCard,
  OffboardingCard,
  SignOutEverywhereCard
} from './PersonAdminTools'
import { PersonAiMemoryCard } from './PersonAiMemory'
import { CompareAccessCard } from './PersonCompare'
import { TeamLoadCard, WhyCard, WorkingOnCard } from './PersonExtras'
import { PersonHeader } from './PersonHeader'
import { AboutCard, AvailabilityCard, PeopleCard, ResponsibilitiesCard } from './PersonOverview'
import { PersonWeekCard } from './PersonWeek'
import { useInvalidatePerson, usePersonProfile } from './types'

export type PersonProfileTab = 'overview' | 'access' | 'activity' | 'tools'
/** The Activity tab's two views: the cards, or one day on a timeline (#1367). */
type ActivityView = 'feed' | 'day'

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
  const [activityView, setActivityView] = useState<ActivityView>('feed')

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

  // #1968 — "This week": administrators and the person's own manager.
  const isTheirManager =
    !!auth?.userId &&
    !!profile.manager?.id &&
    String(profile.manager.id).toUpperCase() === String(auth.userId).toUpperCase()
  const overview = (
    <div className='grid gap-4 lg:grid-cols-2'>
      <div className='space-y-4'>
        <AboutCard profile={profile} isAdmin={isAdmin} />
        <WorkingOnCard profile={profile} />
        {profile.direct_reports.length > 0 && (
          <TeamLoadCard
            userId={profile.id}
            firstName={profile.first_name ?? profile.name}
            expectedRows={profile.direct_reports.length}
          />
        )}
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
        {(isAdmin || isTheirManager) && <PersonWeekCard profile={profile} />}
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
                className='h-7 rounded-md px-3 text-[12px] font-medium text-slate-500 data-[state=active]:bg-nvr-cyan/10 data-[state=active]:text-nvr-navy data-[state=active]:shadow-none dark:text-slate-400 dark:data-[state=active]:text-nvr-cyan'
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
                <AccessSummaryCard userId={profile.id} />
                <PermissionSummaryCard userId={profile.id} />
                <UserScopesCard userId={profile.id} />
                <WhyCard profile={profile} />
                <CompareAccessCard profile={profile} />
              </div>
              <div className='space-y-4'>
                <UserDirectoryCard profile={profile} />
                <SessionsCard userId={profile.id} />
                <ApiTokenCard profile={profile} />
              </div>
            </div>
          </TabsContent>
          <TabsContent value='activity' className='mt-4 focus-visible:outline-none'>
            {/* The tabs only render for administrators; Day reads an
                admin-only, audited endpoint, so it never shows otherwise. */}
            <fieldset
              className='mb-4 inline-flex gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 dark:border-border dark:bg-card'
              data-person-activity-views
            >
              <legend className='sr-only'>Activity view</legend>
              {(
                [
                  ['feed', 'Feed'],
                  ['day', 'Day']
                ] as Array<[ActivityView, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type='button'
                  aria-pressed={activityView === id}
                  data-person-activity-view={id}
                  onClick={() => setActivityView(id)}
                  className={cn(
                    'h-6 rounded-md px-3 text-[11.5px] font-medium',
                    activityView === id
                      ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                      : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                  )}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            {activityView === 'day' && isAdmin ? (
              <DayTimelineCard userId={profile.id} />
            ) : (
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
            )}
          </TabsContent>
          <TabsContent value='tools' className='mt-4 focus-visible:outline-none'>
            <div className='grid gap-4 lg:grid-cols-2'>
              <div className='space-y-4'>
                <ForceReloadCard profile={profile} />
                <SignOutEverywhereCard profile={profile} />
                <MergeCard profile={profile} />
              </div>
              <div className='space-y-4'>
                <OffboardingCard profile={profile} />
                <PersonAiMemoryCard profile={profile} />
                <MyDefaultsCard userId={profile.id} name={profile.first_name ?? profile.name} />
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
