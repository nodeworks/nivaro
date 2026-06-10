import { useQuery } from '@tanstack/react-query'
import { Check, ChevronsUpDown, FunctionSquare, Plus, RefreshCw, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Token model ──────────────────────────────────────────────────────────────
//
// The formula engine (expr-eval, server-side) evaluates formulas with `{ item }`
// as context, so field references serialize to `item.<field>`. Supported
// functions are the ones registered in api/src/services/items.ts.

type TokenKind = 'field' | 'op' | 'func' | 'text'

interface Token {
  kind: TokenKind
  value: string
}

const FUNCTIONS: { name: string; hint: string }[] = [
  { name: 'concat', hint: 'concat(a, b, …) — join values' },
  { name: 'join', hint: 'join(sep, a, b, …) — join with separator' },
  { name: 'upper', hint: 'upper(s) — uppercase' },
  { name: 'lower', hint: 'lower(s) — lowercase' },
  { name: 'trim', hint: 'trim(s) — strip whitespace' },
  { name: 'len', hint: 'len(s) — string length' },
  { name: 'substr', hint: 'substr(s, start, len?) — substring' },
  { name: 'replace', hint: 'replace(s, find, rep) — replace all' },
  { name: 'coalesce', hint: 'coalesce(a, b, …) — first non-empty' }
]

const FUNCTION_NAMES = new Set(FUNCTIONS.map((f) => f.name))

const OPERATORS: { value: string; label: string }[] = [
  { value: '+', label: '+' },
  { value: '-', label: '−' },
  { value: '*', label: '×' },
  { value: '/', label: '÷' },
  { value: '(', label: '(' },
  { value: ')', label: ')' },
  { value: ',', label: ',' },
  { value: '||', label: '|| (concat)' }
]

// ─── Tokenizer ────────────────────────────────────────────────────────────────

function tokenize(formula: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const src = formula ?? ''
  let textBuf = ''

  const flushText = () => {
    if (textBuf.trim()) tokens.push({ kind: 'text', value: textBuf.trim() })
    textBuf = ''
  }

  while (i < src.length) {
    const ch = src[i]

    if (/\s/.test(ch)) {
      flushText()
      i += 1
      continue
    }

    // String literal
    if (ch === '"' || ch === "'") {
      flushText()
      let j = i + 1
      while (j < src.length && src[j] !== ch) j += 1
      tokens.push({ kind: 'text', value: src.slice(i, Math.min(j + 1, src.length)) })
      i = j + 1
      continue
    }

    // item.<field>
    if (src.startsWith('item.', i)) {
      flushText()
      let j = i + 5
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j += 1
      const field = src.slice(i + 5, j)
      if (field) {
        tokens.push({ kind: 'field', value: field })
        i = j
        continue
      }
    }

    // Identifier — function call or bare word
    if (/[a-zA-Z_]/.test(ch)) {
      flushText()
      let j = i
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j += 1
      const word = src.slice(i, j)
      // Skip whitespace to check for '('
      let k = j
      while (k < src.length && /\s/.test(src[k])) k += 1
      if (FUNCTION_NAMES.has(word) && src[k] === '(') {
        tokens.push({ kind: 'func', value: word })
        i = k + 1 // consume the '(' into the func token
      } else {
        tokens.push({ kind: 'text', value: word })
        i = j
      }
      continue
    }

    // Number
    if (/[0-9]/.test(ch)) {
      flushText()
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1
      tokens.push({ kind: 'text', value: src.slice(i, j) })
      i = j
      continue
    }

    // Operators
    if (src.startsWith('||', i)) {
      flushText()
      tokens.push({ kind: 'op', value: '||' })
      i += 2
      continue
    }
    if ('+-*/(),'.includes(ch)) {
      flushText()
      tokens.push({ kind: 'op', value: ch })
      i += 1
      continue
    }

    // Unknown character — accumulate as text
    textBuf += ch
    i += 1
  }
  flushText()
  return tokens
}

function serialize(tokens: Token[]): string {
  const parts: string[] = []
  for (const t of tokens) {
    if (t.kind === 'field') parts.push(`item.${t.value}`)
    else if (t.kind === 'func') parts.push(`${t.value}(`)
    else parts.push(t.value)
  }
  // Join with spaces, then tidy around parens/commas
  return parts.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')').replace(/ ,/g, ',').trim()
}

// ─── Client-side approximate evaluator ────────────────────────────────────────
//
// Best-effort preview only — the real evaluation happens server-side with
// expr-eval. Supports arithmetic, || concatenation, parens, string/number
// literals, item.<field> refs and the registered string helper functions.

type EvalValue = string | number | boolean | null

function approximateEval(formula: string, item: Record<string, unknown>): EvalValue {
  let pos = 0
  const src = formula

  const peek = () => src[pos]
  const skipWs = () => {
    while (pos < src.length && /\s/.test(src[pos])) pos += 1
  }

  function parseExpression(): EvalValue {
    let left = parseTerm()
    skipWs()
    while (pos < src.length) {
      if (src.startsWith('||', pos)) {
        pos += 2
        const right = parseTerm()
        left = `${left ?? ''}${right ?? ''}`
      } else if (peek() === '+' || peek() === '-') {
        const op = src[pos]
        pos += 1
        const right = parseTerm()
        if (op === '+') {
          if (typeof left === 'string' || typeof right === 'string') {
            left = `${left ?? ''}${right ?? ''}`
          } else {
            left = Number(left ?? 0) + Number(right ?? 0)
          }
        } else {
          left = Number(left ?? 0) - Number(right ?? 0)
        }
      } else {
        break
      }
      skipWs()
    }
    return left
  }

  function parseTerm(): EvalValue {
    let left = parseFactor()
    skipWs()
    while (pos < src.length && (peek() === '*' || peek() === '/')) {
      const op = src[pos]
      pos += 1
      const right = parseFactor()
      left =
        op === '*' ? Number(left ?? 0) * Number(right ?? 0) : Number(left ?? 0) / Number(right ?? 0)
      skipWs()
    }
    return left
  }

  function parseArgs(): EvalValue[] {
    const args: EvalValue[] = []
    skipWs()
    if (peek() === ')') {
      pos += 1
      return args
    }
    for (;;) {
      args.push(parseExpression())
      skipWs()
      if (peek() === ',') {
        pos += 1
        continue
      }
      if (peek() === ')') {
        pos += 1
        break
      }
      throw new Error('Expected , or )')
    }
    return args
  }

  function callFn(name: string, args: EvalValue[]): EvalValue {
    const defined = (v: EvalValue) => v !== null && v !== undefined
    switch (name) {
      case 'concat':
        return args.filter(defined).map(String).join('')
      case 'join': {
        const [sep, ...rest] = args
        return rest
          .filter((v) => defined(v) && v !== '')
          .map(String)
          .join(String(sep ?? ''))
      }
      case 'upper':
        return String(args[0] ?? '').toUpperCase()
      case 'lower':
        return String(args[0] ?? '').toLowerCase()
      case 'trim':
        return String(args[0] ?? '').trim()
      case 'len':
        return String(args[0] ?? '').length
      case 'substr': {
        const s = String(args[0] ?? '')
        const start = Number(args[1] ?? 0)
        return args[2] !== undefined
          ? s.substring(start, start + Number(args[2]))
          : s.substring(start)
      }
      case 'replace':
        return String(args[0] ?? '')
          .split(String(args[1] ?? ''))
          .join(String(args[2] ?? ''))
      case 'coalesce':
        return (args.find((v) => defined(v) && v !== '') ?? null) as EvalValue
      default:
        throw new Error(`Unknown function ${name}`)
    }
  }

  function parseFactor(): EvalValue {
    skipWs()
    const ch = peek()
    if (ch === undefined) throw new Error('Unexpected end of formula')

    if (ch === '(') {
      pos += 1
      const v = parseExpression()
      skipWs()
      if (peek() !== ')') throw new Error('Expected )')
      pos += 1
      return v
    }

    if (ch === '-') {
      pos += 1
      return -Number(parseFactor() ?? 0)
    }

    if (ch === '"' || ch === "'") {
      let j = pos + 1
      while (j < src.length && src[j] !== ch) j += 1
      const v = src.slice(pos + 1, j)
      pos = j + 1
      return v
    }

    if (/[0-9.]/.test(ch)) {
      let j = pos
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1
      const v = Number(src.slice(pos, j))
      pos = j
      return v
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let j = pos
      while (j < src.length && /[a-zA-Z0-9_.]/.test(src[j])) j += 1
      const word = src.slice(pos, j)
      pos = j
      skipWs()
      if (peek() === '(' && FUNCTION_NAMES.has(word)) {
        pos += 1
        return callFn(word, parseArgs())
      }
      if (word.startsWith('item.')) {
        const v = item[word.slice(5)]
        return (v ?? null) as EvalValue
      }
      // Bare identifier — treat as item field reference fallback
      return (item[word] ?? null) as EvalValue
    }

    throw new Error(`Unexpected character "${ch}"`)
  }

  const result = parseExpression()
  skipWs()
  if (pos < src.length) throw new Error('Unexpected trailing input')
  return result
}

// ─── Comboboxes ───────────────────────────────────────────────────────────────

function FieldInsertCombobox({
  fields,
  onInsert
}: {
  fields: { field: string; type: string }[]
  onInsert: (field: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-7 justify-between px-2 text-[12px] font-normal'
        >
          <span className='text-muted-foreground'>+ Field</span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No fields
            </CommandEmpty>
            <CommandGroup>
              {fields.map((f) => (
                <CommandItem
                  key={f.field}
                  value={f.field}
                  onSelect={() => {
                    onInsert(f.field)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check className='mr-2 h-3 w-3 opacity-0' />
                  <span className='flex-1 truncate'>{f.field}</span>
                  <span className='ml-2 text-[10px] text-muted-foreground'>{f.type}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function FunctionMenu({ onInsert }: { onInsert: (fn: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-7 justify-between px-2 text-[12px] font-normal'
        >
          <FunctionSquare className='mr-1 h-3 w-3 text-nvr-cyan' />
          <span className='text-muted-foreground'>Function</span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search functions…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No functions
            </CommandEmpty>
            <CommandGroup>
              {FUNCTIONS.map((f) => (
                <CommandItem
                  key={f.name}
                  value={f.name}
                  onSelect={() => {
                    onInsert(f.name)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check className='mr-2 h-3 w-3 opacity-0' />
                  <div className='min-w-0'>
                    <div className='font-mono'>{f.name}()</div>
                    <div className='truncate text-[10.5px] text-muted-foreground'>{f.hint}</div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Chip styles ──────────────────────────────────────────────────────────────

const CHIP_STYLES: Record<TokenKind, string> = {
  field: 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan border-nvr-cyan/30',
  func: 'bg-violet-50 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 border-violet-200 dark:border-violet-800',
  op: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700',
  text: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border-amber-200 dark:border-amber-800'
}

// ─── Main component ───────────────────────────────────────────────────────────

export function FormulaBuilder({
  collection,
  value,
  onChange
}: {
  collection: string
  value: string
  onChange: (v: string) => void
}) {
  const tokens = useMemo(() => tokenize(value), [value])
  const [textDraft, setTextDraft] = useState('')
  const [previewNonce, setPreviewNonce] = useState(0)

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })
  const fields: { field: string; type: string }[] = (colMeta?.fields ?? []).filter(
    (f: { hidden?: boolean }) => !f.hidden
  )

  const apply = (next: Token[]) => onChange(serialize(next))

  const append = (t: Token) => apply([...tokens, t])
  const removeAt = (idx: number) => apply(tokens.filter((_, i) => i !== idx))

  const addText = () => {
    const raw = textDraft.trim()
    if (!raw) return
    // Numbers pass through; everything else becomes a quoted string literal
    // unless it already is one.
    const isNumber = /^-?\d+(\.\d+)?$/.test(raw)
    const isQuoted = /^(['"]).*\1$/.test(raw)
    append({ kind: 'text', value: isNumber || isQuoted ? raw : `"${raw.split('"').join('')}"` })
    setTextDraft('')
  }

  // ── Sample-item preview (approximate, client-side) ──────────────────────────
  const { data: sample, isFetching: sampleLoading } = useQuery({
    queryKey: ['formula-sample-item', collection, previewNonce],
    queryFn: () =>
      api
        .get<{ data: Record<string, unknown>[] }>(`/items/${collection}?limit=1`)
        .then((r) => r.data.data?.[0] ?? null),
    enabled: !!collection && !!value.trim(),
    staleTime: 30_000
  })

  const preview = useMemo(() => {
    if (!value.trim()) return null
    if (!sample) return { ok: false as const, message: 'No sample item available' }
    try {
      const result = approximateEval(value, sample)
      return { ok: true as const, result }
    } catch (err) {
      return { ok: false as const, message: (err as Error).message }
    }
  }, [value, sample])

  return (
    <div className='space-y-2'>
      {/* Token chips */}
      <div className='flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-md border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-900'>
        {tokens.length === 0 && (
          <span className='text-[12px] text-slate-400'>
            Build a formula — insert fields, operators and functions below.
          </span>
        )}
        {tokens.map((t, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no stable identity
            key={`${t.kind}-${t.value}-${i}`}
            className={cn(
              'group inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11.5px]',
              CHIP_STYLES[t.kind]
            )}
          >
            {t.kind === 'field' ? `item.${t.value}` : t.kind === 'func' ? `${t.value}(` : t.value}
            <button
              type='button'
              onClick={() => removeAt(i)}
              className='opacity-40 transition-opacity hover:opacity-100'
              aria-label='Remove token'
            >
              <X className='h-2.5 w-2.5' />
            </button>
          </span>
        ))}
      </div>

      {/* Toolbar */}
      <div className='flex flex-wrap items-center gap-1.5'>
        <FieldInsertCombobox
          fields={fields}
          onInsert={(f) => append({ kind: 'field', value: f })}
        />
        <FunctionMenu onInsert={(fn) => append({ kind: 'func', value: fn })} />
        <div className='flex items-center gap-0.5'>
          {OPERATORS.map((op) => (
            <button
              key={op.value}
              type='button'
              onClick={() => append({ kind: 'op', value: op.value })}
              className='rounded border border-slate-200 bg-white px-1.5 py-1 font-mono text-[11px] text-slate-600 transition-colors hover:border-nvr-cyan/50 hover:text-nvr-cyan dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'
              title={op.label}
            >
              {op.label}
            </button>
          ))}
        </div>
        <div className='flex items-center gap-1'>
          <Input
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addText()
              }
            }}
            placeholder='text / number'
            className='h-7 w-28 text-[11.5px]'
          />
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='h-7 px-2 text-[11px]'
            disabled={!textDraft.trim()}
            onClick={addText}
          >
            <Plus className='h-3 w-3' />
          </Button>
        </div>
      </div>

      {/* Serialized formula */}
      {value.trim() && (
        <code className='block w-full overflow-x-auto rounded bg-slate-100 px-2 py-1.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300'>
          {value}
        </code>
      )}

      {/* Preview */}
      {value.trim() && (
        <div className='flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 dark:border-slate-700 dark:bg-slate-900/60'>
          <span className='shrink-0 text-[11px] font-medium text-slate-500'>
            Preview <span className='font-normal text-slate-400'>(approximate)</span>
          </span>
          <span className='min-w-0 flex-1 truncate font-mono text-[12px] text-slate-800 dark:text-slate-200'>
            {sampleLoading
              ? 'Loading sample…'
              : preview == null
                ? '—'
                : preview.ok
                  ? String(preview.result ?? 'null')
                  : `⚠ ${preview.message}`}
          </span>
          <button
            type='button'
            onClick={() => setPreviewNonce((n) => n + 1)}
            className='shrink-0 rounded p-1 text-slate-400 hover:text-nvr-cyan'
            title='Refresh sample item'
          >
            <RefreshCw className='h-3 w-3' />
          </button>
        </div>
      )}
    </div>
  )
}
