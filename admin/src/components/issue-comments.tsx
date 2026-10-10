/**
 * The comments on an issue (nivaro_comments, collection nivaro_issues) —
 * where a session replay note lands when it is copied onto the issue the
 * recording is linked to (#1363). A replay deep link in the text becomes a
 * "Watch at m:ss" link that opens the recording at that second; everything
 * else is shown as plain text.
 */
import { useQuery } from '@tanstack/react-query'
import { PlayCircle } from 'lucide-react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'

interface IssueComment {
  id: string
  text: string
  created_at: string
  user: { first_name: string | null; last_name: string | null; email: string | null } | null
}

const REPLAY_LINK = /\/session-replays\?recording=([0-9a-f-]{36})&t=(\d+)/i

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Text with its replay deep link pulled out (the line holding it is dropped). */
export function splitReplayLink(text: string): {
  body: string
  link: { href: string; at: number } | null
} {
  const m = REPLAY_LINK.exec(text)
  if (!m) return { body: text, link: null }
  const body = text
    .split('\n')
    .filter((line) => !REPLAY_LINK.test(line))
    .join('\n')
    .trim()
  return { body, link: { href: m[0], at: Number(m[2]) } }
}

export function IssueComments({ issueId }: { issueId: number }) {
  const { data } = useQuery({
    queryKey: ['issue-comments', issueId],
    queryFn: () =>
      api
        .get<{ data: IssueComment[] }>('/comments', {
          params: { collection: 'nivaro_issues', item: String(issueId) }
        })
        .then((r) => r.data.data),
    staleTime: 30_000
  })
  if (!data || data.length === 0) return null
  return (
    <div className='space-y-1.5'>
      <p className='text-[11px] uppercase tracking-wide text-muted-foreground'>Comments</p>
      <ul className='space-y-1.5'>
        {data.map((c) => {
          const { body, link } = splitReplayLink(c.text)
          const who =
            [c.user?.first_name, c.user?.last_name].filter(Boolean).join(' ') ||
            c.user?.email ||
            'Unknown'
          return (
            <li
              key={c.id}
              className='rounded-md border border-slate-200 bg-white px-3 py-2 text-[12px] dark:border-border dark:bg-card'
            >
              <p className='whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100'>
                {body}
              </p>
              <p className='mt-1 flex items-center gap-2 text-[10.5px] text-slate-400'>
                <span>
                  {who} · {formatRelative(c.created_at)}
                </span>
                {link && (
                  <Link
                    to={link.href}
                    className='inline-flex items-center gap-1 font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
                  >
                    <PlayCircle className='h-3 w-3' /> Watch at {clock(link.at)}
                  </Link>
                )}
              </p>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
