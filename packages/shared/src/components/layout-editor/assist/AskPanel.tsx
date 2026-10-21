import {
  ArrowUp,
  FileText,
  LayoutTemplate,
  MessageCircleQuestion,
  Search,
  TextCursorInput
} from 'lucide-react'
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { cn, titleCase } from '../../../lib/utils'
import { useRoleNames } from '../overview/overview-api'
import { PanelBody, PanelHeader } from '../panel-frame'
import { effectText } from '../panel-style'
import type { LayoutKind } from '../settings/settings-registry'
import { parseSaveFailure } from '../useLayoutDraft'
import {
  type AskCite,
  type AskTurn,
  askLayout,
  draftPayload,
  type FoundSetting,
  findSettingAi
} from './assist-api'
import type { JumpResult } from './jump'
import {
  isWhereQuestion,
  type SettingEntry,
  searchSettings,
  settingEntry,
  settingsIndex
} from './settings-index'

/**
 * Ask about this form (#2695) and find a setting by asking (#2676), one panel
 * on the editor's right. "Where do I …" questions are placed by the settings
 * index first (every Form settings and inspector control); only when the
 * words do not place it does the AI pick from the same index, and without AI
 * the closest word matches stay. Every other question goes to the AI with
 * read-only tools (which form a record gets for a role, why a field shows or
 * hides, the layout, role field access, the checks). Answers cite the fields,
 * records and forms they looked at; a citation selects, previews or opens it.
 */

export interface AskPanelProps {
  layoutId: number
  layoutName: string
  kind: LayoutKind
  /** The draft: answers describe what the admin sees, unsaved changes included. */
  bundle: LayoutBundle | null
  thread: AskTurn[]
  setThread: Dispatch<SetStateAction<AskTurn[]>>
  /** A question to run as soon as the panel opens (Form settings' "Ask where"). */
  pending?: string | null
  onPendingTaken?: () => void
  jump(entry: SettingEntry): Promise<JumpResult>
  onCite(cite: AskCite): void
  /** The record the preview shows, for the examples. */
  recordId?: string | null
}

/** The answer as plain text: Markdown emphasis and rules the model may still send are dropped. */
export function plainText(text: string): string {
  return text
    .replace(/^\s*-{3,}\s*$/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

let turnId = 0
const nextId = () => ++turnId

const toFound = (e: SettingEntry): FoundSetting => ({ key: e.key, label: e.label, where: e.where })

const citeIcon = { field: TextCursorInput, record: FileText, layout: LayoutTemplate }

function citeText(c: AskCite): string {
  if (c.kind === 'field') return c.label
  if (c.kind === 'record') return `Record ${c.id}`
  return c.name || `Form #${c.id}`
}

function citeTip(c: AskCite): string {
  if (c.kind === 'field') return 'Select it on the canvas'
  if (c.kind === 'record') return 'Preview the form on this record'
  return 'Open this form'
}

export function AskPanel({
  layoutId,
  layoutName,
  kind,
  bundle,
  thread,
  setThread,
  pending,
  onPendingTaken,
  jump,
  onCite,
  recordId
}: AskPanelProps) {
  const client = useNivaroClient()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [jumpNote, setJumpNote] = useState<{ key: string; text: string } | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const { data: roles = [] } = useRoleNames(true)

  const examples = useMemo(() => {
    const placed = bundle?.placements.find((p) => !p.field.startsWith('__') && p.widget_id == null)
    const field = placed ? placed.label_override || titleCase(placed.field) : null
    const role = roles.find((r) => !/admin/i.test(r.name))?.name
    const out: string[] = []
    if (field && role)
      out.push(`Why can't ${role} see ${field}${recordId ? ` on record ${recordId}` : ''}?`)
    out.push(
      recordId ? `Which form does record ${recordId} get, and why?` : 'Which roles get this form?'
    )
    out.push('Where do I turn off comments?')
    out.push('What do the checks say is wrong with this form?')
    return out
  }, [bundle, roles, recordId])

  const push = (turn: AskTurn) => setThread((t) => [...t, turn])

  useEffect(() => {
    if (thread.length) endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [thread.length])

  const findWhere = async (q: string) => {
    const hits = searchSettings(q, kind, 5)
    const exact = hits.filter((h) => h.score === 1)
    if (exact.length > 0) {
      push({
        id: nextId(),
        role: 'found',
        source: 'search',
        found: exact.slice(0, 3).map((h) => toFound(h.entry)),
        text: null
      })
      return
    }
    try {
      const candidates = settingsIndex()
        .filter((e) => !e.types.length || e.types.includes(kind))
        .map((e) => ({ key: e.key, label: e.label, where: e.where }))
      const res = await findSettingAi(client, { question: q, candidates })
      const found = res.keys.map(settingEntry).filter((e): e is SettingEntry => !!e)
      if (found.length > 0) {
        push({
          id: nextId(),
          role: 'found',
          source: 'ai',
          found: found.map(toFound),
          text: res.explanation
        })
        return
      }
      push({
        id: nextId(),
        role: 'found',
        source: 'search',
        found: hits.slice(0, 3).map((h) => toFound(h.entry)),
        text: res.explanation ?? 'No control fits that. Try other words.'
      })
    } catch (err) {
      const f = parseSaveFailure(err, 'The search failed')
      push({
        id: nextId(),
        role: 'found',
        source: 'search',
        found: hits.slice(0, 3).map((h) => toFound(h.entry)),
        text:
          hits.length > 0
            ? f.status === 503
              ? 'Closest matches by their words (AI is not set up here):'
              : 'Closest matches by their words:'
            : f.status === 503
              ? 'No setting has those words, and AI is not set up here to read the question. Try other words, or use Find a setting in Form settings.'
              : f.message
      })
    }
  }

  const ask = async (raw: string) => {
    const q = raw.trim()
    if (!q || busy) return
    setText('')
    setJumpNote(null)
    // Only questions the AI answered go back as history ("where" questions are
    // answered by the settings search and must not read as unanswered ones).
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
    thread.forEach((t, i) => {
      const next = thread[i + 1]
      if (t.role === 'user' && next?.role === 'assistant')
        history.push({ role: 'user', content: t.text }, { role: 'assistant', content: next.text })
    })
    push({ id: nextId(), role: 'user', text: q })
    setBusy(true)
    try {
      if (isWhereQuestion(q)) await findWhere(q)
      else {
        const res = await askLayout(client, layoutId, {
          question: q,
          history: history.slice(-6),
          draft: draftPayload(bundle)
        })
        push({ id: nextId(), role: 'assistant', text: res.answer, cites: res.cites ?? [] })
      }
    } catch (err) {
      const f = parseSaveFailure(err, 'The question could not be answered')
      push({
        id: nextId(),
        role: 'error',
        text:
          f.status === 503
            ? 'AI is not set up here, so only “where do I …” questions can be answered (by the words of the settings).'
            : f.message
      })
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  // A question handed over from elsewhere (Form settings' search) runs once.
  const askRef = useRef(ask)
  askRef.current = ask
  useEffect(() => {
    if (!pending) return
    onPendingTaken?.()
    void askRef.current(pending)
  }, [pending, onPendingTaken])

  const show = async (f: FoundSetting) => {
    const entry = settingEntry(f.key)
    if (!entry) return
    const res = await jump(entry)
    setJumpNote(res.ok ? null : { key: f.key, text: res.message })
  }

  return (
    <div className='flex h-full min-h-0 flex-col' data-ask-panel=''>
      <PanelHeader
        eyebrow='Ask about this form'
        title={layoutName || 'This form'}
        sub='Answers use the live resolver, permissions and checks. Nothing is changed.'
      />
      <PanelBody className='space-y-3'>
        {thread.length === 0 && (
          <div className='space-y-2'>
            <p className={effectText}>
              Ask why someone sees a field or not, which form a record gets, or where a setting is.
            </p>
            <ul className='space-y-0.5'>
              {examples.map((ex) => (
                <li key={ex}>
                  <button
                    type='button'
                    className='w-full rounded-md px-2 py-1 text-left text-[12.5px] text-slate-700 transition-colors hover:bg-muted dark:text-foreground'
                    onClick={() => void ask(ex)}
                  >
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {thread.map((t) => {
          if (t.role === 'user')
            return (
              <p
                key={t.id}
                className='ml-6 rounded-lg bg-slate-100 px-3 py-2 text-[12.5px] leading-snug text-slate-800 dark:bg-muted dark:text-foreground'
              >
                {t.text}
              </p>
            )
          if (t.role === 'error')
            return (
              <p
                key={t.id}
                role='alert'
                className='text-[12.5px] leading-snug text-[#9c2f47] dark:text-[#f08aa1]'
              >
                {t.text}
              </p>
            )
          if (t.role === 'found')
            return (
              <div key={t.id} className='space-y-1.5' data-ask-found={t.source}>
                {t.text && <p className={effectText}>{t.text}</p>}
                <ul className='space-y-1'>
                  {t.found.map((f) => (
                    <li
                      key={f.key}
                      className='flex items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 dark:border-border'
                    >
                      <Search className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                      <span className='min-w-0 flex-1'>
                        <span className='block truncate text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                          {f.label}
                        </span>
                        <span className={cn(effectText, 'block truncate')}>{f.where}</span>
                        {jumpNote?.key === f.key && (
                          <span className='block text-[12px] leading-snug text-amber-700 dark:text-amber-300'>
                            {jumpNote.text}
                          </span>
                        )}
                      </span>
                      <button
                        type='button'
                        data-ask-jump={f.key}
                        onClick={() => void show(f)}
                        className='inline-flex h-7 shrink-0 items-center rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 transition-colors hover:bg-muted dark:border-border dark:text-foreground'
                      >
                        Show me
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          return (
            <div key={t.id} className='space-y-1.5' data-ask-answer=''>
              <p className='whitespace-pre-wrap text-[12.5px] leading-relaxed text-slate-800 dark:text-foreground'>
                {plainText(t.text)}
              </p>
              {t.cites.length > 0 && (
                <div className='flex flex-wrap gap-1'>
                  {t.cites.map((c) => {
                    const Icon = citeIcon[c.kind]
                    return (
                      <button
                        key={`${c.kind}:${c.kind === 'field' ? c.field : c.id}`}
                        type='button'
                        data-ask-cite={c.kind}
                        data-tip={citeTip(c)}
                        onClick={() => onCite(c)}
                        className='inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-slate-200 px-2 text-[11.5px] text-slate-700 transition-colors hover:bg-muted dark:border-border dark:text-foreground'
                      >
                        <Icon className='h-3 w-3 shrink-0 text-slate-400' />
                        <span className='truncate'>{citeText(c)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
        {busy && <p className={effectText}>Looking it up…</p>}
        <div ref={endRef} />
      </PanelBody>
      <form
        className='flex shrink-0 items-end gap-2 border-t border-slate-200 px-3 py-2.5 dark:border-border'
        onSubmit={(e) => {
          e.preventDefault()
          void ask(text)
        }}
      >
        <MessageCircleQuestion className='mb-2 h-4 w-4 shrink-0 text-slate-400' />
        <textarea
          ref={inputRef}
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void ask(text)
            }
          }}
          placeholder='Ask about this form…'
          aria-label='Ask about this form'
          data-ask-input=''
          className='min-h-[36px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[13px] text-slate-800 outline-none placeholder:text-slate-400 dark:text-foreground dark:placeholder:text-muted-foreground'
        />
        <button
          type='submit'
          aria-label='Ask'
          disabled={busy || !text.trim()}
          className='mb-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-nvr-cyan text-white transition-opacity hover:opacity-90 disabled:opacity-40'
        >
          <ArrowUp className='h-4 w-4' />
        </button>
      </form>
    </div>
  )
}

/** The top-bar toggle for the panel. */
export function AskButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={active}
      data-editor-ask=''
      data-tip='Ask why someone sees a field, which form a record gets, or where a setting is'
      className={cn(
        'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12.5px] font-medium transition-colors',
        active
          ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
      )}
    >
      <MessageCircleQuestion className='h-3.5 w-3.5' />
      Ask
    </button>
  )
}
