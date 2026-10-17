import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Lightbulb, Link2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import {
  errorText,
  IDEA_STATUSES,
  type Idea,
  type IdeaStatus,
  IdeaStatusBadge,
  IdeaVoteButton
} from '@/components/ideas'
import { RelationPicker } from '@/components/relation-picker'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { useGoBack } from '@/lib/nav'
import { formatDateTime } from '@/lib/utils'

interface IdeaDetail extends Idea {
  merged_into_title: string | null
  merged_from: { id: number; title: string }[]
  history: { at: string; by: string | null; status: IdeaStatus; note: string | null }[]
  links: { id: number; type: string; collection: string; item: string; label: string | null }[]
}

export function IdeaDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { user } = useAuth()
  const isAdmin = !!user?.is_admin
  const goBack = useGoBack('/ideas')

  const { data: idea, isLoading } = useQuery({
    queryKey: ['ideas', 'detail', id],
    queryFn: () => api.get<{ data: IdeaDetail }>(`/ideas/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2'>
          <Button variant='ghost' size='icon' className='h-7 w-7' onClick={goBack}>
            <ArrowLeft className='h-4 w-4' />
          </Button>
          <Lightbulb className='h-4 w-4 text-nvr-cyan' />
          <h1 className='truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            {idea?.title ?? (isLoading ? '' : 'Idea not found')}
          </h1>
          {idea && (
            <div className='ml-auto flex items-center gap-2'>
              <IdeaStatusBadge status={idea.status} />
              <IdeaVoteButton idea={idea} />
            </div>
          )}
        </div>
      </header>
      {idea && (
        <div className='min-h-0 flex-1 space-y-4 overflow-y-auto p-6'>
          {idea.merged_into != null && (
            <p className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800'>
              Merged into{' '}
              <Link className='font-medium underline' to={`/ideas/${idea.merged_into}`}>
                {idea.merged_into_title ?? `#${idea.merged_into}`}
              </Link>
              — votes now count there.
            </p>
          )}
          <Card>
            <CardContent className='space-y-2 pt-4 text-[13px]'>
              <p className='whitespace-pre-wrap text-slate-700 dark:text-foreground'>
                {idea.description || 'No description.'}
              </p>
              {idea.status_note && (
                <p className='rounded-md bg-slate-50 px-3 py-2 text-slate-600 dark:bg-muted'>
                  <span className='font-medium'>Note: </span>
                  {idea.status_note}
                </p>
              )}
              {idea.merged_from.length > 0 && (
                <p className='text-[12px] text-slate-500'>
                  Merged here:{' '}
                  {idea.merged_from.map((m, i) => (
                    <span key={m.id}>
                      {i > 0 && ', '}
                      <Link className='underline' to={`/ideas/${m.id}`}>
                        {m.title}
                      </Link>
                    </span>
                  ))}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className='text-[13px]'>Status history</CardTitle>
            </CardHeader>
            <CardContent className='space-y-2 text-[12.5px]'>
              {idea.history.length === 0 ? (
                <p className='text-slate-400'>No status changes yet.</p>
              ) : (
                idea.history.map((h, i) => (
                  <div key={`${h.at}-${i}`} className='flex flex-wrap items-center gap-2'>
                    <IdeaStatusBadge status={h.status} />
                    <span className='text-slate-500'>
                      {formatDateTime(h.at)}
                      {h.by ? ` · ${h.by}` : ''}
                    </span>
                    {h.note && (
                      <span className='text-slate-700 dark:text-foreground'>{h.note}</span>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-1.5 text-[13px]'>
                <Link2 className='h-3.5 w-3.5' /> Backlog links
              </CardTitle>
            </CardHeader>
            <CardContent className='space-y-1 text-[12.5px]'>
              {idea.links.length === 0 ? (
                <p className='text-slate-400'>Not linked to a backlog record.</p>
              ) : (
                idea.links.map((l) => (
                  <p key={l.id}>
                    <span className='text-slate-500'>{l.type} </span>
                    <Link className='underline' to={`/collections/${l.collection}/${l.item}`}>
                      {l.label ?? `${l.collection}/${l.item}`}
                    </Link>
                  </p>
                ))
              )}
            </CardContent>
          </Card>

          {isAdmin && <IdeaAdminControls idea={idea} />}
        </div>
      )}
    </div>
  )
}

function IdeaAdminControls({ idea }: { idea: IdeaDetail }) {
  const qc = useQueryClient()
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['ideas'] })
  const [status, setStatus] = useState<IdeaStatus>(idea.status)
  const [note, setNote] = useState(idea.status_note ?? '')
  const [mergeQuery, setMergeQuery] = useState('')
  const [mergeInto, setMergeInto] = useState<number | null>(null)
  const [linkCollection, setLinkCollection] = useState('')
  const [linkItem, setLinkItem] = useState<unknown>(null)

  useEffect(() => {
    setStatus(idea.status)
    setNote(idea.status_note ?? '')
  }, [idea.status, idea.status_note])

  const { data: collections = [] } = useQuery({
    queryKey: ['collections-lite'],
    queryFn: () =>
      api
        .get<{ data: { collection: string; display_name: string | null; hidden?: boolean }[] }>(
          '/collections'
        )
        .then((r) => r.data.data)
  })
  const { data: candidates = [] } = useQuery({
    queryKey: ['ideas', 'merge-candidates', mergeQuery],
    queryFn: () =>
      api
        .get<{ data: Idea[] }>('/ideas/similar', { params: { q: mergeQuery, limit: 8 } })
        .then((r) => r.data.data),
    enabled: mergeQuery.trim().length >= 2
  })

  const saveStatus = useMutation({
    mutationFn: () =>
      api
        .patch<{ data: { notified: number } }>(`/ideas/${idea.id}/status`, { status, note })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      invalidate()
      toast.success(`Status saved — ${d.notified} voter${d.notified === 1 ? '' : 's'} notified`)
    },
    onError: (e) => toast.error(errorText(e, 'Could not save the status'))
  })
  const merge = useMutation({
    mutationFn: () => api.post(`/ideas/${idea.id}/merge`, { into: mergeInto }),
    onSuccess: () => {
      invalidate()
      setMergeInto(null)
      setMergeQuery('')
      toast.success('Merged — votes moved to the target idea')
    },
    onError: (e) => toast.error(errorText(e, 'Merge failed'))
  })
  const link = useMutation({
    mutationFn: () =>
      api.post(`/ideas/${idea.id}/link`, { collection: linkCollection, id: String(linkItem) }),
    onSuccess: () => {
      invalidate()
      setLinkItem(null)
      toast.success('Linked to the backlog record')
    },
    onError: (e) => toast.error(errorText(e, 'Link failed'))
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-[13px]'>Admin</CardTitle>
      </CardHeader>
      <CardContent className='space-y-5 text-[12.5px]'>
        <section className='space-y-2'>
          <p className='font-medium'>Status</p>
          <SimpleSelect
            value={status}
            onChange={(v) => setStatus(v as IdeaStatus)}
            options={IDEA_STATUSES}
            ariaLabel='Status'
            className='h-8 w-48'
          />
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='Note for voters (why, when, what changed)'
            rows={3}
          />
          <Button size='sm' disabled={saveStatus.isPending} onClick={() => saveStatus.mutate()}>
            Save status and notify voters
          </Button>
        </section>

        {idea.merged_into == null && (
          <section className='space-y-2'>
            <p className='font-medium'>Merge into another idea</p>
            <Input
              value={mergeQuery}
              onChange={(e) => {
                setMergeQuery(e.target.value)
                setMergeInto(null)
              }}
              placeholder='Find the idea to keep…'
              className='h-8'
            />
            {candidates
              .filter((c) => c.id !== idea.id)
              .map((c) => (
                <label key={c.id} className='flex cursor-pointer items-center gap-2'>
                  <input
                    type='radio'
                    name='merge-into'
                    checked={mergeInto === c.id}
                    onChange={() => setMergeInto(c.id)}
                  />
                  <span className='truncate'>{c.title}</span>
                  <span className='text-slate-400'>({c.vote_count} votes)</span>
                </label>
              ))}
            <Button
              size='sm'
              variant='outline'
              disabled={mergeInto == null || merge.isPending}
              onClick={() => merge.mutate()}
            >
              Merge
            </Button>
          </section>
        )}

        <section className='space-y-2'>
          <p className='font-medium'>Link to a backlog record</p>
          <SimpleSelect
            value={linkCollection}
            onChange={(v) => {
              setLinkCollection(v)
              setLinkItem(null)
            }}
            options={[
              { value: '', label: 'Pick a collection…' },
              ...collections
                .filter((c) => !c.hidden && !/^(nivaro|directus)_/.test(c.collection))
                .map((c) => ({ value: c.collection, label: c.display_name || c.collection }))
            ]}
            ariaLabel='Backlog collection'
            className='h-8 w-64'
          />
          {linkCollection && (
            <RelationPicker
              relatedCollection={linkCollection}
              value={linkItem}
              onChange={setLinkItem}
              placeholder='Find the record…'
            />
          )}
          <Button
            size='sm'
            variant='outline'
            disabled={!linkCollection || linkItem == null || link.isPending}
            onClick={() => link.mutate()}
          >
            Link
          </Button>
        </section>
      </CardContent>
    </Card>
  )
}
