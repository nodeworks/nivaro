import { useEffect, useRef, useState } from 'react'

export function useIntersectionObserver(options?: IntersectionObserverInit) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const optionsRef = useRef(options)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsVisible(true)
        observer.disconnect()
      }
    }, optionsRef.current)

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return { ref, isVisible }
}
