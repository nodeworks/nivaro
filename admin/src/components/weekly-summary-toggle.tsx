import { Mail } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/**
 * Opt in to the Monday AI-written issues + operations summary (#1868 #1908). Stored as the
 * `ai_weekly_summary` preference; the section rides the existing daily summary email.
 */
export function WeeklySummaryToggle() {
  const { user, refetch } = useAuth()
  const [busy, setBusy] = useState(false)
  if (!user?.is_admin) return null
  const on = user.preferences?.ai_weekly_summary === true
  const toggle = async () => {
    setBusy(true)
    try {
      await api.patch('/users/me/preferences', { ai_weekly_summary: on ? null : true })
      await refetch()
      toast.success(on ? 'Weekly summary turned off' : 'Weekly summary added to Monday emails')
    } catch {
      toast.error('Could not save the preference')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button
      type='button'
      size='sm'
      variant='outline'
      aria-pressed={on}
      disabled={busy}
      onClick={() => void toggle()}
      title='A short AI-written summary of the week (issues, deploys, slow routes, failures) in your Monday daily summary email'
    >
      <Mail className='mr-1.5 h-3.5 w-3.5' />
      {on ? 'Monday summary: on' : 'Monday summary'}
    </Button>
  )
}
