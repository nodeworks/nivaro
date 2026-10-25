import type { MouseEvent } from 'react'
import { toast } from 'sonner'
import { useApiFetchConfig } from '../../context'

/**
 * A file's Download link that works in every session. A plain link carries
 * only the cookie, so a token session (an admin's View-as, an embed signed in
 * with a bearer) got a raw 401 JSON page. With a token the click fetches the
 * file with it and saves the blob; a cookie session keeps the plain link (and
 * middle-click / open in new tab).
 */
export function useFileDownload(): (
  href: string,
  filename: string | null | undefined
) => ((e: MouseEvent<HTMLAnchorElement>) => void) | undefined {
  const cfg = useApiFetchConfig()
  const token = cfg.authHeaders.Authorization
  return (href, filename) => {
    if (!token) return undefined
    return (e) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      void fetch(href, { headers: cfg.authHeaders, credentials: cfg.credentials })
        .then(async (resp) => {
          if (!resp.ok) throw new Error(String(resp.status))
          const url = URL.createObjectURL(await resp.blob())
          const a = document.createElement('a')
          a.href = url
          a.download = filename || 'download'
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => URL.revokeObjectURL(url), 30_000)
        })
        .catch(() => toast.error('The file could not be downloaded'))
    }
  }
}
