import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowUp, ChevronRight, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
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
  keyCount: number
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
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

interface FusionPanelEntry {
  platform: string
  model: string
  status?: 'ok' | 'failed'
  content?: string
  error?: string
}

type ChatRequestBody = {
  messages: { role: ChatMessage['role']; content: string }[]
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
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(
    () => localStorage.getItem('playground.model') ?? 'auto',
  )
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const { data: fallbackEntries = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const availableModels = fallbackEntries.filter(e => e.keyCount > 0 && e.enabled)
  const modelGroups = [...availableModels]
    .sort((a, b) => (
      a.platform.localeCompare(b.platform) ||
      a.displayName.localeCompare(b.displayName) ||
      a.modelId.localeCompare(b.modelId)
    ))
    .reduce<{ platform: string; models: FallbackEntry[] }[]>((groups, model) => {
      const last = groups[groups.length - 1]
      if (last?.platform === model.platform) {
        last.models.push(model)
      } else {
        groups.push({ platform: model.platform, models: [model] })
      }
      return groups
    }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

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
    if (!text || loading) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setInput('')
    setLoading(true)
    inputRef.current?.focus()

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (keyData?.apiKey) headers['Authorization'] = `Bearer ${keyData.apiKey}`

      const isFusion = selectedModel === 'fusion'
      const body: ChatRequestBody = {
        messages: newMessages.map(m => ({ role: m.role, content: m.content })),
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

  const handleClear = () => {
    setMessages([])
    inputRef.current?.focus()
  }

  const activeModelLabel = selectedModel === 'auto'
    ? t('playground.autoModel')
    : selectedModel === 'fusion'
    ? t('playground.fusionModel')
    : availableModels.find(m => m.modelId === selectedModel)?.displayName ?? selectedModel

  return (
    <div className="flex min-w-0 flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title={t('playground.title')}
        description={t('playground.description')}
        actions={
          <>
            <Select value={selectedModel} onValueChange={(v) => { const m = v ?? 'auto'; setSelectedModel(m); localStorage.setItem('playground.model', m) }}>
              <SelectTrigger className="w-[280px] sm:w-[320px] bg-background/60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="bottom" align="end" alignItemWithTrigger={false} className="max-h-[min(28rem,var(--available-height))]">
                <SelectItem value="auto">{t('playground.autoModel')}</SelectItem>
                <SelectItem value="fusion">
                  <span className="flex items-center gap-2">
                    <span>{t('playground.fusionModel')}</span>
                    <span className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{t('models.newBadge')}</span>
                  </span>
                </SelectItem>
                {modelGroups.length > 0 && <SelectSeparator />}
                {modelGroups.map((group, index) => (
                  <div key={group.platform}>
                    <SelectGroup>
                      <SelectLabel className="px-1.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                        {group.platform}
                      </SelectLabel>
                      {group.models.map(m => (
                        <SelectItem key={m.modelDbId} value={m.modelId}>
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{m.displayName}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{m.platform}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    {index < modelGroups.length - 1 && <SelectSeparator />}
                  </div>
                ))}
                {availableModels.length === 0 && (
                  // Models only appear once a platform has an enabled key. Without
                  // one, the list is just "Auto" and looks broken — say why. (#269)
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    {t('playground.noModels')}
                  </div>
                )}
              </SelectContent>
            </Select>
            {messages.length > 0 && (
              <Button variant="outline" size="sm" onClick={handleClear}>
                {t('playground.clear')}
              </Button>
            )}
          </>
        }
      />

      <div className="flex-1 flex min-w-0 flex-col rounded-3xl border bg-card/80 shadow-sm ring-1 ring-border/40 overflow-hidden min-h-0">
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 space-y-5">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-center">
              <div className="space-y-2 max-w-sm">
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
                    <div className={`flex min-w-0 flex-col gap-1 ${msg.role === 'user' ? 'max-w-[min(80%,42rem)] items-end' : 'max-w-[min(92%,56rem)] items-start'}`}>
                      {showBubble && (
                        <div
                          className={`group relative min-w-0 max-w-full overflow-hidden rounded-2xl px-4 py-2.5 text-sm leading-relaxed break-words shadow-sm ${
                            msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted/80 ring-1 ring-border/50'
                          }`}
                        >
                          {msg.role === 'assistant' ? (
                            <Markdown className="min-w-0 [&_*]:max-w-full [&_code]:break-words [&_pre]:overflow-x-hidden [&_pre]:whitespace-pre-wrap [&_pre_code]:whitespace-pre-wrap">{msg.content}</Markdown>
                          ) : (
                            <div className="whitespace-pre-wrap break-words">{msg.content}</div>
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

        <div className="border-t bg-background/70 p-3 sm:p-4">
          <div className="grid grid-cols-[minmax(0,1fr)_2.5rem] items-end gap-2 rounded-[1.15rem] border bg-background/85 p-1.5 shadow-sm ring-1 ring-border/30">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('playground.inputPlaceholder')}
              rows={1}
              className="min-h-10 max-h-[160px] resize-none rounded-xl border-0 bg-transparent px-3.5 py-2.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/80 focus:outline-none focus:ring-0"
              style={{ height: 'auto', overflow: 'hidden' }}
              onInput={e => {
                const el = e.target as HTMLTextAreaElement
                el.style.height = 'auto'
                el.style.height = Math.min(el.scrollHeight, 160) + 'px'
              }}
            />
            <Button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              size="icon"
              aria-label={loading ? t('playground.sending') : t('playground.send')}
              title={loading ? t('playground.sending') : t('playground.send')}
              className="grid size-10 place-items-center rounded-xl p-0 shadow-sm transition-transform active:scale-95 disabled:opacity-45"
            >
              {loading ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
