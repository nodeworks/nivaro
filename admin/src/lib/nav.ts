import { useLocation, useNavigate } from 'react-router'

/**
 * History-true back. A back arrow must return WHERE THE USER WAS — the queue,
 * record link, or command-palette jump that brought them here — not a
 * hardcoded list route. navigate(-1) when in-app history exists; the page's
 * natural parent only on a cold direct load (location.key === 'default').
 * Same pattern ItemEdit's goBack established.
 */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate()
  useLocation() // re-render on navigation so the idx check below stays fresh
  return () => {
    // React Router stores its history index in history.state.idx — idx > 0
    // means a real previous entry exists EVEN AFTER a full page reload
    // (location.key resets to 'default' on reload and misfires there).
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate(fallback)
  }
}
