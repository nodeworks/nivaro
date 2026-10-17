import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ThumbsUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'

// Idea board (feature requests) — shared by the Ideas list, the idea detail
// page and the "Suggest a feature" dialog. API: /api/ideas.

export type IdeaStatus = 'under_review' | 'planned' | 'built' | 'declined'

export interface Idea {
  id: number
  title: string
  description: string | null
  status: IdeaStatus
  status_note: string | null
  merged_into: number | null
  vote_count: number
  created_by: string | null
  created_at: string
  voted: boolean
}

export const IDEA_STATUSES: { value: IdeaStatus; label: string }[] = [
  { value: 'under_review', label: 'Under review' },
  { value: 'planned', label: 'Planned' },
  { value: 'built', label: 'Built' },
  { value: 'declined', label: 'Declined' }
]

const STATUS_VARIANT: Record<IdeaStatus, 'secondary' | 'default' | 'success' | 'destructive'> = {
  under_review: 'secondary',
  planned: 'default',
  built: 'success',
  declined: 'destructive'
}

export function errorText(e: unknown, fallback: string): string {
  return (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? fallback
}

export function IdeaStatusBadge({ status }: { status: IdeaStatus }) {
  const label = IDEA_STATUSES.find((s) => s.value === status)?.label ?? status
  return <Badge variant={STATUS_VARIANT[status] ?? 'secondary'}>{label}</Badge>
}

/** Vote / unvote; refreshes every idea query on success. */
export function useIdeaVote() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, on }: { id: number; on: boolean }) =>
      on ? api.post(`/ideas/${id}/vote`) : api.delete(`/ideas/${id}/vote`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ideas'] }),
    onError: (e) => toast.error(errorText(e, 'Vote failed'))
  })
}

export function IdeaVoteButton({ idea, disabled }: { idea: Idea; disabled?: boolean }) {
  const vote = useIdeaVote()
  return (
    <Button
      size='sm'
      variant={idea.voted ? 'default' : 'outline'}
      className='h-7 gap-1 px-2 text-[12px]'
      disabled={disabled || vote.isPending || (!idea.voted && idea.merged_into != null)}
      onClick={(e) => {
        e.stopPropagation()
        vote.mutate({ id: idea.id, on: !idea.voted })
      }}
      aria-pressed={idea.voted}
      title={idea.voted ? 'Remove your vote' : 'Vote for this idea'}
    >
      <ThumbsUp className='h-3.5 w-3.5' />
      {idea.vote_count}
    </Button>
  )
}

/** Title-first suggestion form: similar ideas appear while the title is typed,
 *  so a person votes on an existing idea instead of filing a duplicate. */
export function SuggestIdeaDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setQuery(title.trim()), 300)
    return () => clearTimeout(t)
  }, [title])

  useEffect(() => {
    if (!open) {
      setTitle('')
      setDescription('')
      setQuery('')
    }
  }, [open])

  const { data: similar = [], isFetching } = useQuery({
    queryKey: ['ideas', 'similar', query],
    queryFn: () =>
      api
        .get<{ data: Idea[] }>('/ideas/similar', { params: { q: query, limit: 5 } })
        .then((r) => r.data.data),
    enabled: open && query.length >= 2
  })

  const create = useMutation({
    mutationFn: () =>
      api
        .post<{ data: Idea }>('/ideas', { title: title.trim(), description: description.trim() })
        .then((r) => r.data.data),
    onSuccess: (idea) => {
      void qc.invalidateQueries({ queryKey: ['ideas'] })
      toast.success('Thanks — your idea was added with your vote')
      onOpenChange(false)
      navigate(`/ideas/${idea.id}`)
    },
    onError: (e) => toast.error(errorText(e, 'Could not add the idea'))
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-lg'>
        <DialogHeader>
          <DialogTitle>Suggest a feature</DialogTitle>
          <DialogDescription>
            Start with a short title. If someone already asked for it, vote for theirs instead.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className='space-y-3'>
          <Input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='e.g. Export a queue to Excel'
            maxLength={255}
            aria-label='Idea title'
          />
          {query.length >= 2 && (
            <div className='rounded-md border border-slate-200 dark:border-border'>
              <p className='border-b border-slate-100 px-3 py-1.5 text-[11px] font-medium text-slate-500 dark:border-border'>
                {isFetching && similar.length === 0
                  ? 'Looking for similar ideas…'
                  : similar.length > 0
                    ? 'Similar ideas'
                    : 'No similar ideas yet'}
              </p>
              {similar.map((idea) => (
                <div
                  key={idea.id}
                  className='flex items-center gap-2 border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-border'
                >
                  <div className='min-w-0 flex-1'>
                    <button
                      type='button'
                      className='block truncate text-left text-[13px] font-medium text-slate-800 hover:underline dark:text-foreground'
                      onClick={() => {
                        onOpenChange(false)
                        navigate(`/ideas/${idea.id}`)
                      }}
                    >
                      {idea.title}
                    </button>
                    <IdeaStatusBadge status={idea.status} />
                  </div>
                  <IdeaVoteButton idea={idea} />
                </div>
              ))}
            </div>
          )}
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder='What would it let you do, and why does it matter? (optional)'
            rows={4}
            aria-label='Idea description'
          />
        </DialogBody>
        <DialogFooter>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!title.trim() || create.isPending} onClick={() => create.mutate()}>
            Submit idea
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
