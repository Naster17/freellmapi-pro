import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, ChevronRight, ChevronsUpDown, Check, FileText, Image as ImageIcon, Loader2, MessageSquare, Paperclip, Search, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { buildModelOptions } from '@/lib/model-groups'
import { Tooltip } from '@/components/tooltip'
import { PageHeader } from '@/components/page-header'
import { Markdown } from '@/components/markdown'
import { CopyButton } from '@/components/copy-button'
import { useI18n } from '@/i18n'

interface FallbackEntry {
  modelDbId: number
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string
  intelligenceRank: number
  keyCount: number
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  attachments?: AttachmentItem[]
  requestContent?: ChatMessageContent
  meta?: {
    platform?: string
    model?: string
    latency?: number
    fallbackAttempts?: number
    // Fusion responses: the panel models (with their answers, for the
    // collapsible trace) and the judge that synthesized them (null when not
    // synthesized — single survivor / best_of). `fusionStreaming` is true while
    // panel/judge frames are still arriving.
    fusionPanel?: FusionPanelEntry[]
    fusionJudge?: { platform: string; model: string } | null
    fusionStreaming?: boolean
  }
}

interface AttachmentItem {
  id: string
  name: string
  type: string
  size: number
  kind: 'image' | 'file'
  dataUrl?: string
  text?: string
}

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type ChatMessageContent = string | ChatContentPart[]

interface FusionPanelEntry {
  platform: string
  model: string
  status?: 'ok' | 'failed'
  content?: string
  error?: string
}

type ChatRequestBody = {
  messages: { role: ChatMessage['role']; content: ChatMessageContent | string }[]
  model?: string
  stream?: boolean
}

type FusionStreamEvent = {
  _fusion?: {
    event?: 'panel' | 'judge'
    platform: string
    model: string
    status?: FusionPanelEntry['status']
    content?: string
    error?: string
  }
  error?: { message?: string }
  choices?: { delta?: { content?: string } }[]
}

const PROVIDER_LABELS: Record<string, string> = {
  agnes: 'Agnes AI',
  cerebras: 'Cerebras',
  cloudflare: 'Cloudflare',
  cohere: 'Cohere',
  custom: 'Custom',
  github: 'GitHub',
  google: 'Google',
  groq: 'Groq',
  huggingface: 'HuggingFace',
  kilo: 'Kilo',
  llm7: 'LLM7',
  mistral: 'Mistral',
  nvidia: 'NVIDIA',
  ollama: 'Ollama',
  openrouter: 'OpenRouter',
  ovh: 'OVH',
  pollinations: 'Pollinations',
  reka: 'Reka',
  zhipu: 'Zhipu AI',
}

const MAX_TEXT_ATTACHMENT_CHARS = 16000

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isReadableTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  return /\.(c|cpp|cs|css|csv|env|go|h|hpp|html|java|js|jsx|json|log|md|php|py|rb|rs|scss|sh|sql|toml|ts|tsx|txt|xml|ya?ml)$/i.test(file.name)
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function fileToAttachment(file: File, index: number): Promise<AttachmentItem> {
  const base: AttachmentItem = {
    id: `${file.name}-${file.lastModified}-${file.size}-${index}`,
    name: file.name,
    type: file.type || 'application/octet-stream',
    size: file.size,
    kind: file.type.startsWith('image/') ? 'image' : 'file',
  }

  if (base.kind === 'image') {
    return { ...base, dataUrl: await readFileAsDataUrl(file) }
  }

  if (!isReadableTextFile(file)) return base

  const text = await file.slice(0, MAX_TEXT_ATTACHMENT_CHARS).text()
  return {
    ...base,
    text: file.size > MAX_TEXT_ATTACHMENT_CHARS
      ? `${text}\n\n[Attachment text truncated to ${MAX_TEXT_ATTACHMENT_CHARS} characters.]`
      : text,
  }
}

function buildMessageContent(text: string, attachments: AttachmentItem[]): ChatMessageContent {
  const parts: ChatContentPart[] = []
  if (text) parts.push({ type: 'text', text })

  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.dataUrl) {
      parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl } })
      continue
    }

    const fileText = [
      `Attached file: ${attachment.name}`,
      `Type: ${attachment.type}`,
      `Size: ${formatFileSize(attachment.size)}`,
      '',
      attachment.text ? `Content:\n${attachment.text}` : 'Content was not embedded because this file is not readable text.',
    ].join('\n')
    parts.push({ type: 'text', text: fileText })
  }

  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider
}

// Render a fusion panel/judge entry as "platform/model", but avoid doubling
// the provider when the model id already carries it (e.g. openrouter/owl-alpha,
// groq/compound) — those would otherwise read "openrouter/openrouter/owl-alpha".
function fusionRouteLabel(p: { platform: string; model: string }): string {
  return p.model.startsWith(`${p.platform}/`) ? p.model : `${p.platform}/${p.model}`
}

// Collapsible, minimal-font trace shown OUTSIDE the main answer bubble: each
// panel model's raw answer as it streamed in, plus the judge that synthesized
// the final answer. Default-open so you can watch it work; collapse to tuck away.
function FusionTrace({ panel, judge, streaming, answerStarted }: {
  panel: FusionPanelEntry[]
  judge?: { platform: string; model: string } | null
  streaming?: boolean
  answerStarted?: boolean
}) {
  const { t } = useI18n()
  // Open while the panel streams in so you can watch it work; auto-collapse the
  // moment the final answer STARTS streaming (first token in the bubble), so it
  // tucks away as the answer takes over — unless the user manually toggled it.
  const [open, setOpen] = useState(true)
  const touched = useRef(false)
  useEffect(() => {
    if (answerStarted && !touched.current) setOpen(false)
  }, [answerStarted])
  return (
    <div className="w-full min-w-0 overflow-hidden text-[10px] leading-snug text-muted-foreground/80">
      <button
        type="button"
        onClick={() => { touched.current = true; setOpen(o => !o) }}
        className="inline-flex items-center gap-1 font-mono hover:text-foreground transition-colors"
      >
        <ChevronRight className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {t('playground.fusionTrace', { count: panel.length })}{streaming ? ' …' : ''}
      </button>
      {open && (
        <div className="mt-1 min-w-0 space-y-2 border-l border-border/60 pl-2.5">
          {panel.map((p, i) => (
            <div key={i} className="min-w-0 space-y-0.5">
              <span className="break-all font-mono font-medium">{fusionRouteLabel(p)}</span>
              {p.status === 'failed'
                ? <span className="ml-1.5 text-amber-600 dark:text-amber-400">{t('playground.fusionFailed')}{p.error ? `: ${p.error}` : ''}</span>
                : p.content
                  ? <div className="whitespace-pre-wrap break-words opacity-80">{p.content}</div>
                  : <span className="ml-1.5 opacity-60">…</span>}
            </div>
          ))}
          {judge && (
            <div className="min-w-0 border-t border-border/60 pt-1.5">
              <span className="break-all font-mono font-medium">{fusionRouteLabel(judge)}</span>
              <span className="ml-1.5 opacity-70">{t('playground.fusionJudgeSynth')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function PlaygroundPage() {
  const { t } = useI18n()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [systemPrompt, setSystemPrompt] = useState<string>(
    () => localStorage.getItem('playground.systemPrompt') ?? '',
  )
  const [systemPromptOpen, setSystemPromptOpen] = useState<boolean>(
    () => !!localStorage.getItem('playground.systemPrompt'),
  )
  const updateSystemPrompt = (v: string) => {
    setSystemPrompt(v)
    localStorage.setItem('playground.systemPrompt', v)
  }
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem('playground.model') ?? 'auto',
  )
  const [modelQuery, setModelQuery] = useState('')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 640px)').matches,
  )
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  // Unification is always on now (the on/off toggle was removed), so the picker
  // always collapses a model's providers into one option.
  const unifyOn = true

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)
  // Collapse the same model from multiple providers into one option (value =
  // canonical id, which the proxy resolves to the whole group).
  const modelOptions = buildModelOptions(availableModels, unifyOn)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const media = window.matchMedia('(min-width: 640px)')
    const sync = () => {
      setIsDesktop(media.matches)
      setModelPickerOpen(false)
    }
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  // Read a fusion SSE stream, updating the assistant message in place as panel
  // answers + the judge arrive (additive `_fusion` frames) and the final answer
  // streams as content deltas.
  const streamFusion = async (stream: ReadableStream<Uint8Array>, baseMessages: ChatMessage[], start: number) => {
    const reader = stream.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let finalContent = ''
    const panel: FusionPanelEntry[] = []
    let judge: { platform: string; model: string } | null = null

    const flush = (streaming: boolean) => {
      setMessages([...baseMessages, {
        role: 'assistant',
        content: finalContent,
        meta: { latency: Date.now() - start, fusionPanel: [...panel], fusionJudge: judge, fusionStreaming: streaming },
      }])
    }
    flush(true)

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const tl = line.trim()
        if (!tl.startsWith('data:')) continue
        const d = tl.slice(5).trim()
        if (d === '[DONE]') continue
        let obj: FusionStreamEvent
        try { obj = JSON.parse(d) } catch { continue }
        if (obj._fusion) {
          if (obj._fusion.event === 'panel') {
            panel.push({ platform: obj._fusion.platform, model: obj._fusion.model, status: obj._fusion.status, content: obj._fusion.content, error: obj._fusion.error })
          } else if (obj._fusion.event === 'judge') {
            judge = { platform: obj._fusion.platform, model: obj._fusion.model }
          }
          flush(true)
        } else if (obj.error) {
          finalContent = `${t('playground.errorPrefix')} ${obj.error.message}`
          flush(true)
        } else if (obj.choices) {
          const delta = obj.choices[0]?.delta?.content
          if (delta) { finalContent += delta; flush(true) }
        }
      }
    }
    flush(false)
  }

  const handleSend = async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || loading || attachmentsLoading) return

    const messageAttachments = attachments
    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      attachments: messageAttachments,
      requestContent: buildMessageContent(text, messageAttachments),
    }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setAttachments([])
    setLoading(true)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    inputRef.current?.focus()

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const isFusion = selectedModel === 'fusion'
      const sysPrompt = systemPrompt.trim()
      const body: ChatRequestBody = {
        messages: [
          ...(sysPrompt ? [{ role: 'system' as const, content: sysPrompt }] : []),
          ...newMessages.map(m => ({ role: m.role, content: m.requestContent ?? m.content })),
        ],
      }
      if (selectedModel !== 'auto') body.model = selectedModel
      // Fusion streams its panel + judge trace; ask for a stream so the
      // Playground can show the other models arriving before the final answer.
      if (isFusion) body.stream = true

      const base = import.meta.env.BASE_URL.replace(/\/$/, '')
      const start = Date.now()
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      const latency = Date.now() - start
      const routedVia = res.headers.get('X-Routed-Via')
      const fallbackAttempts = res.headers.get('X-Fallback-Attempts')

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }))
        setMessages([...newMessages, {
          role: 'assistant',
          content: `${t('playground.errorPrefix')} ${err.error?.message ?? t('common.unknownError')}`,
        }])
        return
      }

      if (isFusion && res.body) {
        await streamFusion(res.body, newMessages, start)
        return
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? JSON.stringify(data, null, 2)
      const via = data._routed_via ?? (routedVia ? {
        platform: routedVia.split('/')[0],
        model: routedVia.split('/').slice(1).join('/'),
      } : undefined)

      // Fusion responses carry a structured routing summary so we can show the
      // panel models that replied + the judge, rather than parsing the compact
      // X-Routed-Via string.
      const fusion = data._fusion as
        | { panel: { platform: string; model: string }[]; judge: { platform: string; model: string } | null }
        | undefined

      setMessages([...newMessages, {
        role: 'assistant',
        content,
        meta: {
          platform: via?.platform,
          model: via?.model,
          latency,
          fallbackAttempts: fallbackAttempts ? parseInt(fallbackAttempts) : undefined,
          fusionPanel: fusion?.panel,
          fusionJudge: fusion?.judge,
        },
      }])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setMessages([...newMessages, {
        role: 'assistant',
        content: `${t('playground.errorPrefix')} ${message}`,
      }])
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleAttachmentPick = async (files: FileList | null) => {
    const picked = Array.from(files ?? [])
    if (picked.length === 0) return

    setAttachmentsLoading(true)
    try {
      const baseIndex = attachments.length
      const next = await Promise.all(picked.map((file, i) => fileToAttachment(file, baseIndex + i)))
      setAttachments(current => [...current, ...next])
      setAttachmentPickerOpen(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    } finally {
      setAttachmentsLoading(false)
      if (imageInputRef.current) imageInputRef.current.value = ''
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments(current => current.filter(attachment => attachment.id !== id))
    inputRef.current?.focus()
  }

  const handleClear = () => {
    setMessages([])
    inputRef.current?.focus()
  }

  // Searchable picker options: auto + fusion pinned at the top, then every model
  // ordered BY INTELLIGENCE — size tier first (Frontier→Small), then the catalog
  // rank within the tier, name as the final tiebreaker. (Raw intelligence_rank is
  // per-provider, not global, so tier-first matches the server's preset; #135.)
  const pickerOptions = [
    { value: 'auto', label: t('playground.autoModel'), sub: '', isNew: false, platforms: [] as string[], section: t('playground.routingSection') },
    { value: 'fusion', label: t('playground.fusionModel'), sub: '', isNew: true, platforms: [] as string[], section: t('playground.routingSection') },
    ...modelOptions
      .slice()
      .sort((a, b) =>
        a.platform.localeCompare(b.platform, undefined, { sensitivity: 'base' }) ||
        a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
      .map(o => ({
        value: o.value,
        label: o.label,
        sub: o.providerCount > 1 ? t('models.providerCount', { count: o.providerCount }) : o.platform,
        isNew: false,
        section: providerLabel(o.platform),
        // Provider names for the multi-provider hover + search; empty when solo.
        platforms: o.providerCount > 1 ? o.platforms : [],
      })),
  ]
  // Literal, case-insensitive substring match against name, providers, and id.
  const modelQ = modelQuery.trim().toLowerCase()
  const filteredOptions = modelQ
    ? pickerOptions.filter(o => `${o.label} ${o.sub} ${o.value} ${o.platforms.join(' ')}`.toLowerCase().includes(modelQ))
    : pickerOptions

  function pickModel(v: string) {
    setSelectedModel(v)
    localStorage.setItem('playground.model', v)
    setModelPickerOpen(false)
    setModelQuery('')
  }

  const activeModelLabel = selectedModel === 'auto'
    ? t('playground.autoModel')
    : selectedModel === 'fusion'
    ? t('playground.fusionModel')
    : modelOptions.find(o => o.value === selectedModel)?.label ?? selectedModel

  const modelSelect = (triggerClassName: string) => (
    <Popover open={modelPickerOpen} onOpenChange={(o) => { setModelPickerOpen(o); if (!o) setModelQuery('') }}>
      <PopoverTrigger
        aria-label={t('playground.selectModel')}
        className={`flex items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-input px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 ${triggerClassName}`}
      >
        <span className="truncate">{activeModelLabel}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-2rem))] p-0">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={modelQuery}
            onChange={e => setModelQuery(e.target.value)}
            placeholder={t('playground.searchModels')}
            className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {filteredOptions.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">{t('playground.noModelsFound')}</div>
          ) : (
            filteredOptions.map((o, i) => {
              const showSection = i === 0 || filteredOptions[i - 1]?.section !== o.section
              return (
                <div key={o.value}>
                  {showSection && (
                    <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover/95 px-2 pb-1 pt-2 backdrop-blur supports-[backdrop-filter]:bg-popover/80 first:pt-1">
                      <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/75">{o.section}</span>
                      <span className="h-px flex-1 bg-border/70" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => pickModel(o.value)}
                    className={`flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors ${o.value === selectedModel ? 'border-border bg-accent text-accent-foreground shadow-sm' : 'border-transparent hover:bg-accent hover:text-accent-foreground'}`}
                  >
                    <Check className={`size-4 shrink-0 ${o.value === selectedModel ? 'opacity-100' : 'opacity-0'}`} />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.isNew && <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{t('models.newBadge')}</span>}
                    {o.sub && (o.platforms.length > 1
                      ? <Tooltip text={t('models.servedBy', { providers: o.platforms.join(', ') })}><span className="shrink-0 text-xs text-muted-foreground underline decoration-dotted underline-offset-2">{o.sub}</span></Tooltip>
                      : <span className="shrink-0 text-xs text-muted-foreground">{o.sub}</span>)}
                  </button>
                </div>
              )
            })
          )}
          {!modelQ && availableModels.length === 0 && (
            // Models only appear once a platform has an enabled key. Without
            // one, the list is just Auto/Fusion and looks broken — say why. (#269)
            <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('playground.noModels')}</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100dvh-49px)] min-w-0 flex-col overflow-hidden sm:mx-0 sm:my-0 sm:h-[calc(100vh-8rem)]">
      {isDesktop ? (
        <div>
          <PageHeader
            title={t('playground.title')}
            description={t('playground.description')}
            actions={
              <>
                {modelSelect('h-9 w-[320px] bg-background/60')}
                {messages.length > 0 && (
                  <Button variant="outline" size="sm" onClick={handleClear}>
                    {t('playground.clear')}
                  </Button>
                )}
              </>
            }
          />
        </div>
      ) : (
        <div className="flex shrink-0 flex-col gap-3 border-b bg-background/95 px-4 pb-3 pt-3 backdrop-blur">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight">{t('playground.title')}</h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{t('playground.mobileDescription')}</p>
            </div>
            {messages.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleClear} className="shrink-0">
                {t('playground.clear')}
              </Button>
            )}
          </div>
          {modelSelect('h-10 w-full bg-background/70 text-left')}
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background sm:rounded-3xl sm:border sm:bg-card/80 sm:shadow-sm sm:ring-1 sm:ring-border/40">
        <div className="flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-4 py-4 pb-6 sm:p-6">
          {messages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center">
              <div className="w-full max-w-sm space-y-3 rounded-[1.35rem] border bg-card/55 px-5 py-6 shadow-sm ring-1 ring-border/35 sm:rounded-3xl sm:px-6 sm:py-7">
                <div className="mx-auto flex size-9 items-center justify-center rounded-full border bg-muted/50 text-muted-foreground sm:size-10">
                  <MessageSquare className="size-4" />
                </div>
                <p className="text-base font-medium">{t('playground.emptyTitle')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('playground.emptyDescription', { model: activeModelLabel })}
                </p>
              </div>
            </div>
          ) : (
            <>
              {messages.map((msg, i) => {
                const fusionPanel = msg.meta?.fusionPanel
                const okPanel = fusionPanel?.filter(p => p.status !== 'failed') ?? []
                // Skip an empty assistant bubble while the fusion trace is still
                // streaming in (no final answer yet) — the trace shows below.
                const showBubble = msg.role === 'user' || msg.content.length > 0
                return (
                  <div key={i} className={`flex min-w-0 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`flex min-w-0 flex-col gap-1 ${msg.role === 'user' ? 'max-w-[88%] items-end sm:max-w-[min(80%,42rem)]' : 'max-w-[95%] items-start sm:max-w-[min(92%,56rem)]'}`}>
                      {showBubble && (
                        <div
                          className={`group relative min-w-0 max-w-full overflow-hidden rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words shadow-sm ${
                            msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted/80 ring-1 ring-border/50'
                          }`}
                        >
                          {msg.role === 'assistant' ? (
                            <Markdown className="min-w-0 [&_*]:max-w-full [&_code]:break-words [&_pre]:overflow-x-hidden [&_pre]:whitespace-pre-wrap [&_pre_code]:whitespace-pre-wrap">{msg.content}</Markdown>
                          ) : (
                            <>
                              {msg.content && <div className="whitespace-pre-wrap break-words">{msg.content}</div>}
                              {msg.attachments && msg.attachments.length > 0 && (
                                <div className={`flex flex-wrap gap-1.5 ${msg.content ? 'mt-2' : ''}`}>
                                  {msg.attachments.map(attachment => (
                                    <div key={attachment.id} className="flex max-w-full items-center gap-2 rounded-xl bg-primary-foreground/12 px-2 py-1 text-xs ring-1 ring-primary-foreground/20">
                                      {attachment.kind === 'image' && attachment.dataUrl ? (
                                        <img src={attachment.dataUrl} alt="" className="size-7 rounded-lg object-cover ring-1 ring-primary-foreground/20" />
                                      ) : attachment.kind === 'image' ? (
                                        <ImageIcon className="size-3.5 shrink-0" />
                                      ) : (
                                        <FileText className="size-3.5 shrink-0" />
                                      )}
                                      <span className="min-w-0 truncate">{attachment.name}</span>
                                      <span className="shrink-0 opacity-70">{formatFileSize(attachment.size)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                          {msg.role === 'assistant' && msg.content && (
                            <CopyButton
                              text={msg.content}
                              label={t('playground.copyReply')}
                              className="absolute right-1.5 top-1.5 size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                            />
                          )}
                          {msg.meta && (
                            <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px] opacity-70 tabular-nums">
                              {(fusionPanel || msg.meta.fusionStreaming) ? (
                                <>
                                  {okPanel.length > 0 && (
                                    <span className="min-w-0 break-words">
                                      {t('playground.fusionPanel')}:{' '}
                                      <span className="font-mono break-all">{okPanel.map(fusionRouteLabel).join(', ')}</span>
                                    </span>
                                  )}
                                  {msg.meta.fusionJudge && (
                                    <span className="min-w-0 break-words">
                                      · {t('playground.fusionJudge')}:{' '}
                                      <span className="font-mono break-all">{fusionRouteLabel(msg.meta.fusionJudge)}</span>
                                    </span>
                                  )}
                                  {msg.meta.latency != null && <span>· {msg.meta.latency} ms</span>}
                                </>
                              ) : (
                                <>
                                  {msg.meta.platform && <span>{msg.meta.platform}</span>}
                                  {msg.meta.model && <span className="min-w-0 break-all font-mono">· {msg.meta.model}</span>}
                                  {msg.meta.latency != null && <span>· {msg.meta.latency} ms</span>}
                                  {msg.meta.fallbackAttempts != null && msg.meta.fallbackAttempts > 0 && (
                                    <span>· {msg.meta.fallbackAttempts} {msg.meta.fallbackAttempts > 1 ? t('playground.fallbacks') : t('playground.fallback')}</span>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                      {msg.role === 'assistant' && fusionPanel && fusionPanel.length > 0 && (
                        <FusionTrace
                          panel={fusionPanel}
                          judge={msg.meta?.fusionJudge}
                          streaming={msg.meta?.fusionStreaming}
                          answerStarted={msg.content.length > 0}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
              {loading && !messages[messages.length - 1]?.meta?.fusionStreaming && (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-2xl px-4 py-3">
                    <div className="flex gap-1">
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="size-1.5 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <div className="shrink-0 border-t bg-background/95 px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-3 sm:bg-background/70 sm:p-4">
          <div className="rounded-[1.15rem] border bg-card/90 p-1.5 shadow-lg shadow-black/10 ring-1 ring-border/35 sm:bg-background/85">
            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5 border-b border-border/60 px-1 pb-1.5">
                {attachments.map(attachment => (
                  <div key={attachment.id} className="flex max-w-full items-center gap-2 rounded-xl border bg-muted/45 px-2 py-1 text-xs shadow-sm">
                    {attachment.kind === 'image' && attachment.dataUrl ? (
                      <img src={attachment.dataUrl} alt="" className="size-7 rounded-lg object-cover ring-1 ring-border/70" />
                    ) : attachment.kind === 'image' ? (
                      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 max-w-[9rem] truncate sm:max-w-[14rem]">{attachment.name}</span>
                    <span className="shrink-0 text-muted-foreground">{formatFileSize(attachment.size)}</span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(attachment.id)}
                      aria-label={t('playground.removeAttachment')}
                      title={t('playground.removeAttachment')}
                      className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-[2.25rem_1fr_2.25rem] items-end gap-1.5">
              <Popover open={attachmentPickerOpen} onOpenChange={setAttachmentPickerOpen}>
                <PopoverTrigger
                  aria-label={t('playground.attach')}
                  title={t('playground.attach')}
                  className="grid size-9 place-items-center rounded-xl text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 aria-expanded:bg-muted aria-expanded:text-foreground"
                >
                  {attachmentsLoading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
                </PopoverTrigger>
                <PopoverContent align="start" side="top" className="w-48 p-1.5">
                  <button
                    type="button"
                    onClick={() => { setAttachmentPickerOpen(false); imageInputRef.current?.click() }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                  >
                    <ImageIcon className="size-4 text-muted-foreground" />
                    {t('playground.attachPhoto')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setAttachmentPickerOpen(false); fileInputRef.current?.click() }}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                  >
                    <FileText className="size-4 text-muted-foreground" />
                    {t('playground.attachFile')}
                  </button>
                </PopoverContent>
              </Popover>
              <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={e => handleAttachmentPick(e.target.files)} />
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e => handleAttachmentPick(e.target.files)} />
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('playground.inputPlaceholder')}
                rows={1}
                className="min-h-9 max-h-[140px] resize-none rounded-xl border-0 bg-transparent px-2 py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground/75 focus:outline-none focus:ring-0"
                style={{ height: 'auto', overflow: 'hidden' }}
                onInput={e => {
                  const el = e.target as HTMLTextAreaElement
                  el.style.height = 'auto'
                  el.style.height = Math.min(el.scrollHeight, 140) + 'px'
                }}
              />
              <Button
                onClick={handleSend}
                disabled={loading || attachmentsLoading || (!input.trim() && attachments.length === 0)}
                aria-label={loading ? t('playground.sending') : t('playground.send')}
                title={loading ? t('playground.sending') : t('playground.send')}
                className="grid size-9 place-items-center rounded-xl p-0 shadow-sm transition-transform active:scale-95"
              >
                {loading ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              </Button>
            </div>
            <div className="mt-1.5 px-1">
              <button
                type="button"
                onClick={() => setSystemPromptOpen(o => !o)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ChevronRight className={`size-3 transition-transform ${systemPromptOpen ? 'rotate-90' : ''}`} />
                {t('playground.systemPromptLabel')}
                {systemPrompt.trim() && <span className="ml-1 size-1.5 rounded-full bg-primary/70" />}
              </button>
              {systemPromptOpen && (
                <textarea
                  value={systemPrompt}
                  onChange={e => updateSystemPrompt(e.target.value)}
                  placeholder={t('playground.systemPromptPlaceholder')}
                  rows={2}
                  className="mt-1 w-full resize-y rounded-lg border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring/40 min-h-[36px] max-h-[120px]"
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
