import { useEffect, useState } from 'react'

/**
 * The modal a recording was started from, while it is still in the document;
 * null once it is gone (the dialog closed, or the app navigated). Re-renders
 * the caller at that moment, so the bar and the setup dialog fall back to
 * document.body instead of staying in a detached node.
 */
export function useConnectedHost(host: HTMLElement | null | undefined, active: boolean) {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!host || !active) return
    const mo = new MutationObserver(() => {
      if (!host.isConnected) bump((n) => n + 1)
    })
    mo.observe(document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [host, active])
  return host?.isConnected ? host : null
}
