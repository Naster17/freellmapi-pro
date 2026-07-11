import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { CooldownList, type CooldownEntry } from '@/components/cooldown-list'
import type { ApiKey, ApiKeyModel, Platform } from '../../../shared/types'
import { Activity, ChevronDown, Clock3, ExternalLink, Globe, Loader2, Pencil, Server, Trash2 } from 'lucide-react'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useI18n } from '@/i18n'

// Claude (Anthropic) model families the mapping editor exposes. Anthropic
// clients send these names; each maps to "auto" (router picks a free model) or
// a pinned catalog model. Mirrors services/anthropic-map.ts on the server.
type ClaudeFamily = 'default' | 'opus' | 'sonnet' | 'haiku'
type AnthropicMap = Record<ClaudeFamily, string>
interface MappableModel { modelId: string; displayName: string; enabled: boolean }
const FAMILY_ORDER: { key: ClaudeFamily; labelKey: string }[] = [
  { key: 'default', labelKey: 'keys.familyDefault' },
  { key: 'opus', labelKey: 'keys.familyOpus' },
  { key: 'sonnet', labelKey: 'keys.familySonnet' },
  { key: 'haiku', labelKey: 'keys.familyHaiku' },
]

// Small "Get API key" external link shown next to a provider (#137).
function GetKeyLink({ url }: { url: string }) {
  const { t } = useI18n()
  if (!url) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {t('keys.getApiKey')}
      <ExternalLink className="size-3" />
    </a>
  )
}

// `url` points to each provider's key-management / signup page so the Keys page
// can show a "Get API key" shortcut (#137). OpenCode Zen's key is free from
// opencode.ai/auth — no card needed; billing only applies to paid models (#128).
// `keyless: true` providers (Kilo's anonymous free tier) need no API key — the
// form disables the key field and submits a sentinel the backend stores so
// routing treats the platform as configured.
const PLATFORMS: { value: Platform; label: string; url: string; keyless?: boolean }[] = [
  { value: 'google', label: 'Google AI Studio', url: 'https://aistudio.google.com/apikey' },
  { value: 'groq', label: 'Groq', url: 'https://console.groq.com/keys' },
  { value: 'cerebras', label: 'Cerebras', url: 'https://cloud.cerebras.ai' },
  { value: 'nvidia', label: 'NVIDIA NIM', url: 'https://build.nvidia.com/settings/api-keys' },
  { value: 'mistral', label: 'Mistral', url: 'https://console.mistral.ai/api-keys/' },
  { value: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/keys' },
  { value: 'github', label: 'GitHub Models', url: 'https://github.com/settings/tokens' },
  { value: 'cohere', label: 'Cohere', url: 'https://dashboard.cohere.com/api-keys' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI', url: 'https://dash.cloudflare.com' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)', url: 'https://z.ai/manage-apikey/apikey-list' },
  { value: 'ollama', label: 'Ollama Cloud', url: 'https://ollama.com/settings/keys' },
  { value: 'kilo', label: 'Kilo Gateway (no key needed)', url: 'https://app.kilo.ai', keyless: true },
  { value: 'pollinations', label: 'Pollinations (no key needed)', url: 'https://pollinations.ai', keyless: true },
  { value: 'ovh', label: 'OVH AI Endpoints (no key needed)', url: 'https://endpoints.ai.cloud.ovh.net', keyless: true },
  { value: 'llm7', label: 'LLM7 (anon ok)', url: 'https://llm7.io' },
  { value: 'huggingface', label: 'HuggingFace Router', url: 'https://huggingface.co/settings/tokens' },
  { value: 'opencode', label: 'OpenCode Zen (free key)', url: 'https://opencode.ai/auth' },
  { value: 'agnes', label: 'Agnes AI (free key)', url: 'https://platform.agnes-ai.com' },
  { value: 'reka', label: 'Reka (free key)', url: 'https://platform.reka.ai' },
  { value: 'siliconflow', label: 'SiliconFlow (image + TTS)', url: 'https://siliconflow.com' },
  { value: 'routeway', label: 'Routeway (free key)', url: 'https://routeway.ai' },
  { value: 'bazaarlink', label: 'BazaarLink (free key)', url: 'https://bazaarlink.ai' },
  { value: 'ainative', label: 'AINative Studio (free key)', url: 'https://ainative.studio' },
  { value: 'aihorde', label: 'AI Horde (no key needed, slow)', url: 'https://aihorde.net/register', keyless: true },
  { value: 'g4f', label: 'g4f.space', url: 'https://g4f.space' },
  { value: 'freetheai', label: 'FreeTheAi (free key)', url: 'https://freetheai.xyz' },
]

// 'custom' is configured through its own form (base URL + model), not the
// generic key dropdown — but it still appears in the grouped provider list.
const CUSTOM_GROUP: { value: Platform; label: string; url: string } = {
  value: 'custom',
  label: 'Custom (OpenAI-compatible)',
  url: '',
}

const CUSTOM_MODEL_KIND_LABEL: Record<ApiKeyModel['kind'], string> = {
  chat: 'keys.customTypeChat',
  embedding: 'keys.customTypeEmbedding',
  image: 'keys.customTypeImage',
  audio: 'keys.customTypeAudio',
}

function customModelDeleteKey(model: ApiKeyModel): string {
  return `${model.kind}:${model.id}`
}

function customModelDeletePath(model: ApiKeyModel): string {
  if (model.kind === 'chat') return `/api/models/custom/${model.id}`
  if (model.kind === 'embedding') return `/api/embeddings/custom/${model.id}`
  return `/api/media/custom/${model.id}`
}

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-amber-500',
  unknown: 'bg-muted-foreground/40',
}

const statusLabelKey: Record<string, string> = {
  healthy: 'status.healthy',
  rate_limited: 'status.rateLimited',
  invalid: 'status.invalid',
  error: 'status.error',
  unknown: 'status.unchecked',
}

const MAX_KEYLESS_QTY = 100
const MAX_VISIBLE_PROVIDER_KEYS_DESKTOP = 10
const MAX_VISIBLE_PROVIDER_KEYS_MOBILE = 5
const FEED_MODE_STORAGE_KEY = 'freellmapi.keys.feedMode'

interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: {
    id: number
    platform: string
    status: string
    lastCheckedAt: string | null
    activeCooldowns: number
    cooldowns: CooldownEntry[]
  }[]
  checkAllInFlight?: boolean
  checkAllStartedAt?: number | null
}

function UnifiedKeySection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data, isError } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…'
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  function copy() {
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">{t('keys.unifiedKey')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('keys.unifiedKeyDescBefore')}<code className="font-mono">api_key</code>{t('keys.unifiedKeyDescAfter')}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending || isError}
        >
          {t('keys.regenerate')}
        </Button>
      </div>

      {isError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
          {t('keys.serverUnreachableBefore')}<code className="font-mono">{baseUrl.replace('/v1', '')}</code>{t('keys.serverUnreachableAfter')}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-lg select-all truncate tabular-nums">
            {showKey ? apiKey : masked}
          </code>
          <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
            {showKey ? t('keys.hideKey') : t('keys.showKey')}
          </Button>
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? t('keys.copiedKey') : t('keys.copyKey')}
          </Button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">{t('keys.baseUrl')}</span>
        <code className="font-mono">{baseUrl}</code>
        <span className="text-muted-foreground">{t('keys.endpointChat')}</span>
        <code className="font-mono">/v1/chat/completions</code>
        <span className="text-muted-foreground">{t('keys.endpointResponses')}</span>
        <code className="font-mono">/v1/responses</code>
        <span className="text-muted-foreground">{t('keys.endpointMessages')}</span>
        <code className="font-mono">/v1/messages <span className="text-muted-foreground">({t('keys.endpointMessagesHint')})</span></code>
        <span className="text-muted-foreground">{t('keys.endpointEmbeddings')}</span>
        <code className="font-mono">/v1/embeddings <span className="text-muted-foreground">({t('keys.endpointEmbeddingsHint')})</span></code>
      </div>
    </section>
  )
}

function ProxySettingsSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [proxyUrl, setProxyUrl] = useState('')

  const { data, isError } = useQuery<{ proxyUrl: string; enabled: boolean; bypassPlatforms: string[]; active: boolean }>({
    queryKey: ['proxy-url'],
    queryFn: () => apiFetch('/api/settings/proxy'),
  })

  useEffect(() => {
    if (data) setProxyUrl(data.proxyUrl)
  }, [data?.proxyUrl])

  const saveProxy = useMutation({
    mutationFn: (body: { proxyUrl?: string; enabled?: boolean; bypassPlatforms?: string[] }) =>
      apiFetch<{ proxyUrl: string; enabled: boolean; bypassPlatforms: string[]; active: boolean }>('/api/settings/proxy', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: (result: { proxyUrl: string; enabled: boolean; bypassPlatforms: string[]; active: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ['proxy-url'] })
      setProxyUrl(result.proxyUrl)
    },
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    saveProxy.mutate({ proxyUrl })
  }

  const enabled = data?.enabled ?? true
  const active = data?.active ?? false

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium flex items-center gap-2">
            <Globe className="size-3.5 text-muted-foreground" />
            {t('keys.outboundProxy')}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('keys.outboundProxyDescription')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => saveProxy.mutate({ enabled: checked })}
            disabled={saveProxy.isPending || !data}
          />
          {active && enabled && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-medium">
              {t('common.active')}
            </span>
          )}
        </div>
      </div>

      {isError ? (
        <p className="text-xs text-muted-foreground">{t('keys.proxyLoadFailed')}</p>
      ) : (
        <form onSubmit={submit} className="flex items-end gap-3">
          <div className="space-y-1.5 flex-1">
            <Label className="text-xs">{t('keys.proxyUrl')}</Label>
            <Input
              value={proxyUrl}
              onChange={e => setProxyUrl(e.target.value)}
              placeholder="socks5://127.0.0.1:1080"
              className="font-mono text-xs"
            />
          </div>
          <Button type="submit" size="sm" disabled={saveProxy.isPending}>
            {saveProxy.isPending ? t('keys.savingProxy') : t('keys.saveProxy')}
          </Button>
        </form>
      )}

      {saveProxy.isError && (
        <p className="text-destructive text-xs mt-2">{(saveProxy.error as Error).message}</p>
      )}

      <div className="mt-3 text-[11px] text-muted-foreground">
        <p>
          {t('keys.proxyEnvHintBefore')}<code className="font-mono">PROXY_URL</code>{t('keys.proxyEnvHintAfter')}
        </p>
        <ul className="list-disc list-inside mt-1 space-y-0.5">
          <li><code className="font-mono">socks5://127.0.0.1:1080</code></li>
          <li><code className="font-mono">http://proxy.corp.com:8080</code></li>
          <li><code className="font-mono">socks5://user:pass@proxy:1080</code></li>
        </ul>
      </div>
    </section>
  )
}

// Split a free-text model field on commas / newlines into a clean id list,
// dropping blanks and duplicates so one endpoint can take several models. (#281)
function parseModelList(raw: string): string[] {
  const seen = new Set<string>()
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !seen.has(s) && seen.add(s))
}

function CustomProviderSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [customType, setCustomType] = useState<'chat' | 'embedding' | 'image' | 'audio'>('chat')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [family, setFamily] = useState('')
  const [apiKey, setApiKey] = useState('')

  const models = customType === 'chat' ? parseModelList(model) : [model.trim()].filter(Boolean)
  const multiple = customType === 'chat' && models.length > 1

  const { data: embeddingsData } = useQuery<{ families: { family: string }[] }>({
    queryKey: ['embeddings'],
    queryFn: () => apiFetch('/api/embeddings'),
  })

  const addCustom = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      apiFetch(path, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['embeddings'] })
      queryClient.invalidateQueries({ queryKey: ['media'] })
      setModel('')
      setDisplayName('')
      setFamily('')
    },
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!baseUrl || models.length === 0) return
    const common = {
      baseUrl,
      model: models[0],
      displayName: !multiple ? (displayName || undefined) : undefined,
      apiKey: apiKey || undefined,
    }
    if (customType === 'chat') {
      addCustom.mutate({
        path: '/api/keys/custom',
        body: {
          baseUrl,
          models,
          displayName: !multiple ? (displayName || undefined) : undefined,
          apiKey: apiKey || undefined,
        },
      })
      return
    }
    if (customType === 'embedding') {
      addCustom.mutate({
        path: '/api/embeddings/custom',
        body: { ...common, family: family || undefined },
      })
      return
    }
    addCustom.mutate({
      path: '/api/media/custom',
      body: { ...common, modality: customType },
    })
  }

  const modelPlaceholder = customType === 'chat'
    ? 'qwen3:4b, llama3:8b'
    : customType === 'embedding'
      ? 'text-embedding-3-small'
      : customType === 'image'
        ? 'gpt-image-1'
        : 'gpt-4o-mini-tts'
  const addLabel = customType === 'chat'
    ? (multiple ? t('keys.addModels', { count: models.length }) : t('keys.addModel'))
    : customType === 'embedding'
      ? t('keys.addEmbeddingModel')
      : customType === 'image'
        ? t('keys.addImageModel')
        : t('keys.addAudioModel')

  return (
    <section>
      <h2 className="text-sm font-medium mb-1">{t('keys.addCustom')}</h2>
      <p className="text-xs text-muted-foreground mb-3">
        {t('keys.addCustomDescription')}
      </p>
      <form onSubmit={submit} className="flex flex-wrap gap-3 rounded-3xl border p-4 bg-card">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.customType')}</Label>
          <Select value={customType} onValueChange={(v) => setCustomType(v as typeof customType)}>
            <SelectTrigger className="w-[160px] py-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chat">{t('keys.customTypeChat')}</SelectItem>
              <SelectItem value="embedding">{t('keys.customTypeEmbedding')}</SelectItem>
              <SelectItem value="image">{t('keys.customTypeImage')}</SelectItem>
              <SelectItem value="audio">{t('keys.customTypeAudio')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 flex-1 min-w-[240px]">
          <Label className="text-xs">{t('keys.customBaseUrl')}</Label>
          <Input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:11434/v1"
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{customType === 'chat' ? t('keys.customModels') : t('keys.customModel')}</Label>
          <Input
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder={modelPlaceholder}
            className="w-[200px] font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.customDisplayName')}</Label>
          <Input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder={multiple ? t('keys.customDisplayNamePerModel') : t('keys.customDisplayNameOptional')}
            disabled={multiple}
            className="w-[150px]"
          />
        </div>
        {customType === 'embedding' && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.customFamily')}</Label>
            <Input
              value={family}
              onChange={e => setFamily(e.target.value)}
              placeholder={embeddingsData?.families?.[0]?.family ?? t('keys.customFamilyPlaceholder')}
              className="w-[190px] font-mono text-xs"
            />
          </div>
        )}
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.customApiKey')}</Label>
          <div className="flex flex-wrap items-center space-x-3">
            <Input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={t('keys.customDisplayNameOptional')}
              className="w-[150px] font-mono text-xs"
            />
            <Button type="submit" size="sm" disabled={!baseUrl || models.length === 0 || addCustom.isPending}>
              {addCustom.isPending ? t('keys.addingCustom') : addLabel}
            </Button>
          </div>
        </div>
      </form>
      {addCustom.isError && (
        <p className="text-destructive text-xs mt-2">{(addCustom.error as Error).message}</p>
      )}
    </section>
  )
}

// Claude (Anthropic) model mapping: point a Claude / Anthropic SDK client at
// this server and decide how its built-in model names route into the free pool.
function AnthropicSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // Anthropic clients append `/v1/messages` to the base URL, so they want the
  // bare origin (OpenAI clients use origin + /v1, shown in the key section).
  const origin = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}`
    : window.location.origin

  const { data: mapData } = useQuery<{ map: AnthropicMap }>({
    queryKey: ['anthropic-map'],
    queryFn: () => apiFetch('/api/settings/anthropic-map'),
  })
  const { data: models = [] } = useQuery<MappableModel[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const [draft, setDraft] = useState<AnthropicMap | null>(null)
  useEffect(() => { if (mapData?.map) setDraft(mapData.map) }, [mapData])

  const save = useMutation({
    mutationFn: (map: AnthropicMap) => apiFetch('/api/settings/anthropic-map', { method: 'PUT', body: JSON.stringify(map) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['anthropic-map'] }),
  })

  // Dedup catalog models by id; only enabled models can be pinned.
  const modelOptions = Array.from(new Map(models.filter(m => m.enabled).map(m => [m.modelId, m])).values())
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
  const dirty = !!(draft && mapData?.map && JSON.stringify(draft) !== JSON.stringify(mapData.map))

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">{t('keys.anthropicTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-prose">{t('keys.anthropicDesc')}</p>
        </div>
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => draft && save.mutate(draft)}>
          {save.isSuccess && !dirty ? t('keys.anthropicSaved') : t('keys.anthropicSave')}
        </Button>
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs mb-4">
        <span className="text-muted-foreground">{t('keys.anthropicBaseUrl')}</span>
        <code className="font-mono break-all">{origin}</code>
        <span className="text-muted-foreground">{t('keys.anthropicAuth')}</span>
        <code className="font-mono">x-api-key</code>
      </div>

      <div className="space-y-2">
        {FAMILY_ORDER.map(({ key, labelKey }) => (
          <div key={key} className="flex items-center gap-3">
            <span className="w-40 text-xs font-medium shrink-0">{t(labelKey)}</span>
            <Select
              value={draft?.[key] ?? 'auto'}
              onValueChange={(v) => setDraft(d => (d ? { ...d, [key]: v } : d))}
            >
              <SelectTrigger className="w-[320px] max-w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('keys.anthropicAuto')}</SelectItem>
                {/* Keep a currently-pinned-but-now-disabled model selectable. */}
                {draft?.[key] && draft[key] !== 'auto' && !modelOptions.some(m => m.modelId === draft[key]) && (
                  <SelectItem value={draft[key]}>{draft[key]}</SelectItem>
                )}
                {modelOptions.map(m => (
                  <SelectItem key={m.modelId} value={m.modelId}>{m.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground mt-4 max-w-prose">{t('keys.anthropicNote')}</p>
    </section>
  )
}

type KeysTab = 'providers' | 'apiKey' | 'anthropic'
const KEYS_TABS: { id: KeysTab; labelKey: string }[] = [
  { id: 'providers', labelKey: 'keys.tabProviders' },
  { id: 'apiKey', labelKey: 'keys.tabApiKey' },
  { id: 'anthropic', labelKey: 'keys.tabAnthropic' },
]

export default function KeysPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<KeysTab>('providers')
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [keylessQty, setKeylessQty] = useState('')
  const [expandedProviderKeys, setExpandedProviderKeys] = useState<Record<string, boolean>>({})
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [feedMode, setFeedMode] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(FEED_MODE_STORAGE_KEY) === 'true'
  })
  const [isDesktopKeysView, setIsDesktopKeysView] = useState(() =>
    typeof window === 'undefined' ? true : window.matchMedia('(min-width: 640px)').matches,
  )
  const [editingKeyId, setEditingKeyId] = useState<number | null>(null)
  const [editingLabel, setEditingLabel] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [confirmDeleteModelKey, setConfirmDeleteModelKey] = useState<string | null>(null)
  const [expandedKeyIds, setExpandedKeyIds] = useState<Set<number>>(new Set())
  const editInputRef = useRef<HTMLInputElement>(null)

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: (query) => {
      const data = query.state.data as HealthData | undefined
      if (data?.checkAllInFlight) return 1500
      return 15_000
    },
  })

  const addKey = useMutation({
    mutationFn: async ({ count = 1, ...body }: { platform: string; key: string; label?: string; count?: number }) => {
      const created = []
      for (let i = 0; i < count; i += 1) {
        created.push(await apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }))
      }
      return created
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
      setKeylessQty('')
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const deleteCustomModel = useMutation({
    mutationFn: (model: ApiKeyModel) => apiFetch(customModelDeletePath(model), { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['embeddings'] })
      queryClient.invalidateQueries({ queryKey: ['media'] })
    },
  })

  const [kickedCheckAt, setKickedCheckAt] = useState<number | null>(null)
  const [kickedCheckGen, setKickedCheckGen] = useState(0)
  const MIN_CHECKING_VISIBLE_MS = 1200

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onMutate: () => {
      setKickedCheckAt(Date.now())
      setKickedCheckGen(g => g + 1)
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  useEffect(() => {
    if (kickedCheckAt === null) return
    if (!healthData || healthData.checkAllInFlight) return
    const elapsed = Date.now() - kickedCheckAt
    const remaining = Math.max(0, MIN_CHECKING_VISIBLE_MS - elapsed)
    const gen = kickedCheckGen
    const timer = setTimeout(() => {
      setKickedCheckAt(current => (current !== null && kickedCheckGen === gen ? null : current))
    }, remaining)
    return () => clearTimeout(timer)
  }, [healthData, kickedCheckAt, kickedCheckGen])

  const isCheckingActive = checkAll.isPending || !!healthData?.checkAllInFlight || kickedCheckAt !== null

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const checkProvider = useMutation({
    mutationFn: (keyIds: number[]) => Promise.all(keyIds.map(id => apiFetch(`/api/health/check/${id}`, { method: 'POST' }))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const togglePlatform = useMutation({
    mutationFn: ({ platform, enabled }: { platform: string; enabled: boolean }) =>
      apiFetch(`/api/keys/platform/${platform}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const toggleAllPlatforms = useMutation({
    mutationFn: (enabled: boolean) =>
      Promise.all(grouped.map(g => apiFetch(`/api/keys/platform/${g.value}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const updateKey = useMutation({
    mutationFn: ({ id, label, enabled }: { id: number; label?: string; enabled?: boolean }) =>
      apiFetch(`/api/keys/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...(label !== undefined ? { label } : {}), ...(enabled !== undefined ? { enabled } : {}) }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setEditingKeyId(null)
      setEditingLabel('')
    },
  })

  function startEditing(key: ApiKey) {
    setEditingKeyId(key.id)
    setEditingLabel(key.label)
  }

  function cancelEditing() {
    setEditingKeyId(null)
    setEditingLabel('')
  }

  function saveEditing(id: number) {
    if (editingLabel !== undefined) {
      updateKey.mutate({ id, label: editingLabel })
    }
  }

  function toggleExpandedKey(id: number) {
    setExpandedKeyIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    if (editingKeyId !== null && editInputRef.current) {
      editInputRef.current.focus()
    }
  }, [editingKeyId])

  useEffect(() => {
    window.localStorage.setItem(FEED_MODE_STORAGE_KEY, String(feedMode))
  }, [feedMode])

  useEffect(() => {
    const media = window.matchMedia('(min-width: 640px)')
    const sync = () => setIsDesktopKeysView(media.matches)
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  const needsAccountId = platform === 'cloudflare'
  const isKeyless = PLATFORMS.find(p => p.value === platform)?.keyless ?? false
  const keylessQtyText = keylessQty.trim()
  const keylessQtyValid = !keylessQtyText || (/^[1-9]\d*$/.test(keylessQtyText) && Number(keylessQtyText) <= MAX_KEYLESS_QTY)
  const keylessQtyCount = isKeyless && keylessQtyText && keylessQtyValid ? Number(keylessQtyText) : 1

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform) return
    if (!isKeyless && !apiKey) return
    if (needsAccountId && !accountId) return
    if (!keylessQtyValid) return
    // Keyless providers submit an empty key; the backend stores a sentinel.
    const key = isKeyless ? '' : (needsAccountId ? `${accountId}:${apiKey}` : apiKey)
    addKey.mutate({ platform, key, label: label || undefined, count: keylessQtyCount })
  }

  const healthKeyMap = new Map<number, HealthData['keys'][number]>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)
  const healthPlatformMap = new Map<string, HealthPlatform>()
  for (const p of healthData?.platforms ?? []) healthPlatformMap.set(p.platform, p)

  const totalActiveCooldowns = (healthData?.keys ?? []).reduce((sum, k) => sum + (k.cooldowns?.length ?? 0), 0)
  const cooledKeyCount = (healthData?.keys ?? []).filter(k => (k.cooldowns?.length ?? 0) > 0).length

  // Proxy bypass: shared query with ProxySettingsSection (same queryKey).
  const { data: proxyData } = useQuery<{ proxyUrl: string; enabled: boolean; bypassPlatforms: string[]; active: boolean }>({
    queryKey: ['proxy-url'],
    queryFn: () => apiFetch('/api/settings/proxy'),
  })
  const bypassPlatforms = proxyData?.bypassPlatforms ?? []
  const proxyEnabled = proxyData?.enabled ?? true

  const toggleBypass = useMutation({
    mutationFn: (platform: string) => {
      const next = bypassPlatforms.includes(platform)
        ? bypassPlatforms.filter(p => p !== platform)
        : [...bypassPlatforms, platform]
      return apiFetch('/api/settings/proxy', { method: 'PUT', body: JSON.stringify({ bypassPlatforms: next }) })
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['proxy-url'] }),
  })

  const grouped = [...PLATFORMS, CUSTOM_GROUP].map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0)
  const anyProviderEnabled = grouped.some(g => g.keys.some(k => k.enabled))

  return (
    <div>
      <PageHeader
        title={t('keys.pageTitle')}
        description={t('keys.pageDescription')}
        actions={
          <>
            <div className="inline-flex gap-1 rounded-xl border p-1">
              {KEYS_TABS.map(tb => (
                <button
                  key={tb.id}
                  type="button"
                  onClick={() => setTab(tb.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
                    tab === tb.id ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  {t(tb.labelKey)}
                </button>
              ))}
            </div>
          </>
        }
      />

      <div className="space-y-8">
        {tab === 'apiKey' && (
          <>
            <UnifiedKeySection />
            <ProxySettingsSection />
          </>
        )}

        {tab === 'anthropic' && <AnthropicSection />}

        {tab === 'providers' && (
        <>
        <section>
          <h2 className="text-sm font-medium mb-3">{t('keys.addProvider')}</h2>
          <form onSubmit={handleSubmit} className="flex flex-wrap gap-3 rounded-3xl border p-4 bg-card">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('keys.platform')}</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder={t('keys.selectPlatform')} />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {(() => {
                const sel = PLATFORMS.find(p => p.value === platform)
                return sel?.url ? <div className="pt-0.5"><GetKeyLink url={sel.url} /></div> : null
              })()}
            </div>
            {needsAccountId && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('keys.accountId')}</Label>
                <Input
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  placeholder="a1b2c3d4…"
                  className="w-[200px] font-mono text-xs"
                />
              </div>
            )}
            <div className="space-y-1.5 flex-1 min-w-[240px]">
              <Label className="text-xs">{needsAccountId ? t('keys.apiToken') : t('keys.customApiKey')}</Label>
              <Input
                type="password"
                value={isKeyless ? '' : apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={isKeyless ? t('keys.noKeyNeededPlaceholder') : (needsAccountId ? t('keys.bearerTokenPlaceholder') : t('keys.pasteKeyPlaceholder'))}
                className="font-mono text-xs"
                disabled={isKeyless}
              />
              {isKeyless && (
                <p className="text-[11px] text-muted-foreground">
                  {t('keys.keylessHint')}
                </p>
              )}
            </div>
            {isKeyless && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('keys.qty')}</Label>
                <Input
                  value={keylessQty}
                  onChange={e => setKeylessQty(e.target.value)}
                  placeholder="1"
                  inputMode="numeric"
                  className="w-[100px] font-mono text-xs"
                />
                {!keylessQtyValid && (
                  <p className="text-destructive text-[11px]">
                    {t('keys.keylessQtyInvalid', { max: MAX_KEYLESS_QTY })}
                  </p>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">{t('keys.label')}</Label>
              <div className="flex flex-wrap items-center space-x-3">
                <Input
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  placeholder={t('keys.customDisplayNameOptional')}
                  className="w-[160px]"
                />
                <Button type="submit" size="sm" disabled={!platform || (!isKeyless && !apiKey) || (needsAccountId && !accountId) || addKey.isPending}>
                  {addKey.isPending ? t('keys.adding') : isKeyless ? t('keys.enable') : t('keys.addKey')}
                </Button>
              </div>
            </div>
          </form>
          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
          )}
        </section>

        <CustomProviderSection />

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium">{t('keys.configuredProviders')}</h2>
            {grouped.length > 0 && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => checkAll.mutate()}
                  disabled={isCheckingActive}
                >
                  {isCheckingActive && <Loader2 className="size-3 animate-spin" />}
                  {isCheckingActive ? t('keys.checking') : t('keys.checkAll')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggleAllPlatforms.mutate(!anyProviderEnabled)}
                  disabled={toggleAllPlatforms.isPending || togglePlatform.isPending}
                >
                  {anyProviderEnabled ? 'Disable all' : 'Enable all'}
                </Button>
                <Button
                  variant={feedMode ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setFeedMode(v => !v)}
                  className="gap-1.5"
                >
                  Feed Mode
                  <Server className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
          {totalActiveCooldowns > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border bg-muted/40 px-3 py-2 text-xs">
              <Clock3 className="size-3.5 text-muted-foreground" />
              <span className="font-medium">{t('keys.activeCooldowns')}</span>
              <span className="text-muted-foreground tabular-nums">
                {t('keys.cooldownSummary', {
                  cooledKeys: cooledKeyCount,
                  cooldowns: totalActiveCooldowns,
                })}
              </span>
            </div>
          )}
          {healthData?.checkAllInFlight && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border bg-muted/40 px-3 py-2 text-xs">
              <Activity className="size-3.5 animate-pulse text-muted-foreground" />
              <span className="font-medium">{t('keys.checkInFlight')}</span>
            </div>
          )}
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : keys.length === 0 ? (
            <div className="rounded-3xl border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                {t('keys.noProviderKeys')}
              </p>
            </div>
          ) : feedMode ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {grouped.map(group => {
                const platformHealth = healthPlatformMap.get(group.value)
                const keysWithStatus = group.keys.map(k => ({ key: k, status: healthKeyMap.get(k.id)?.status ?? k.status }))
                const enabledCount = group.keys.filter(k => k.enabled).length
                const disabledCount = group.keys.length - enabledCount
                const healthyCount = platformHealth?.healthyKeys ?? keysWithStatus.filter(k => k.status === 'healthy').length
                const rateLimitedCount = platformHealth?.rateLimitedKeys ?? keysWithStatus.filter(k => k.status === 'rate_limited').length
                const invalidCount = platformHealth?.invalidKeys ?? keysWithStatus.filter(k => k.status === 'invalid').length
                const errorCount = platformHealth?.errorKeys ?? keysWithStatus.filter(k => k.status === 'error').length
                const unknownCount = platformHealth?.unknownKeys ?? keysWithStatus.filter(k => k.status === 'unknown').length
                const activeTokens = keysWithStatus.filter(({ key, status }) => key.enabled && status === 'healthy').length
                const inactiveTokens = group.keys.length - activeTokens
                const healthScore = group.keys.length > 0 ? Math.round((healthyCount / group.keys.length) * 100) : 0
                const feedExpanded = expandedProvider === group.value
                const maxVisible = isDesktopKeysView ? MAX_VISIBLE_PROVIDER_KEYS_DESKTOP : MAX_VISIBLE_PROVIDER_KEYS_MOBILE
                const visibleKeys = expandedProviderKeys[group.value] === true ? group.keys : group.keys.slice(0, maxVisible)
                const hiddenCount = group.keys.length - visibleKeys.length

                return (
                  <div
                    key={group.value}
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedProvider(current => current === group.value ? null : group.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setExpandedProvider(current => current === group.value ? null : group.value)
                      }
                    }}
                    className={`rounded-2xl border bg-card/90 p-3 shadow-sm transition-colors ${enabledCount === 0 ? 'opacity-50 saturate-0' : 'hover:border-foreground/20'}`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`size-2 rounded-full ${activeTokens > 0 ? 'animate-pulse bg-emerald-500 shadow-[0_0_18px_rgba(16,185,129,0.65)]' : 'bg-muted-foreground/30'}`} />
                          <h3 className="min-w-0 truncate text-sm font-semibold">{group.label}</h3>
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground tabular-nums">
                          <span>{group.keys.length} total</span>
                          <span>{enabledCount} on</span>
                          {disabledCount > 0 && <span>{disabledCount} off</span>}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2" onClick={e => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => checkProvider.mutate(group.keys.map(k => k.id))}
                          disabled={checkProvider.isPending}
                        >
                          Check
                        </Button>
                        <Switch
                          checked={group.keys.some(k => k.enabled)}
                          onCheckedChange={(checked) =>
                            togglePlatform.mutate({ platform: group.value, enabled: checked })
                          }
                          disabled={togglePlatform.isPending}
                        />
                      </div>
                    </div>

                    <div className="mb-2 grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-xl border bg-background/40 px-2.5 py-2">
                      <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                        <Activity className="size-3 animate-pulse text-emerald-500" />
                        <span className="truncate">Live Feed</span>
                      </div>
                      <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-1 text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                        <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                        {activeTokens}
                      </div>
                      <div className="flex items-center gap-1.5 rounded-full bg-rose-500/10 px-2 py-1 text-xs font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                        <span className="size-1.5 animate-pulse rounded-full bg-rose-500" />
                        {inactiveTokens}
                      </div>
                    </div>

                    <div className="mb-2 grid grid-cols-7 gap-1.5 text-[10px]">
                      <div className="col-span-2 rounded-lg bg-muted/45 px-2 py-1.5">
                        <span className="block text-muted-foreground">Health</span>
                        <strong className="tabular-nums">{healthScore}%</strong>
                      </div>
                      <div className="rounded-lg bg-muted/45 px-2 py-1.5">
                        <span className="block text-muted-foreground">OK</span>
                        <strong className="tabular-nums text-emerald-600 dark:text-emerald-400">{healthyCount}</strong>
                      </div>
                      <div className="rounded-lg bg-muted/45 px-2 py-1.5">
                        <span className="block text-muted-foreground">RL</span>
                        <strong className="tabular-nums text-amber-600 dark:text-amber-400">{rateLimitedCount}</strong>
                      </div>
                      <div className="rounded-lg bg-muted/45 px-2 py-1.5">
                        <span className="block text-muted-foreground">Inv</span>
                        <strong className="tabular-nums text-rose-600 dark:text-rose-400">{invalidCount}</strong>
                      </div>
                      <div
                        className="rounded-lg bg-muted/45 px-2 py-1.5"
                        title={t('keys.errorStatusHint')}
                      >
                        <span className="block text-muted-foreground">Err</span>
                        <strong className="tabular-nums text-amber-600 dark:text-amber-400">{errorCount}</strong>
                      </div>
                      <div className="rounded-lg bg-muted/45 px-2 py-1.5">
                        <span className="block text-muted-foreground">?</span>
                        <strong className="tabular-nums">{unknownCount}</strong>
                      </div>
                    </div>

                    <div className="flex min-h-7 items-center justify-between gap-2 border-t pt-2" onClick={e => e.stopPropagation()}>
                      {proxyEnabled ? (
                        <div className="inline-flex items-center gap-1.5">
                          <Globe className="size-3 text-muted-foreground" />
                          <span className="text-[10px] text-muted-foreground">Proxy</span>
                          <Switch
                            checked={!bypassPlatforms.includes(group.value)}
                            onCheckedChange={() => toggleBypass.mutate(group.value)}
                            disabled={toggleBypass.isPending}
                          />
                        </div>
                      ) : <span className="text-[10px] text-muted-foreground">Proxy off</span>}
                      <GetKeyLink url={group.url} />
                    </div>
                    {feedExpanded && (
                      <div className="mt-2 space-y-1" onClick={e => e.stopPropagation()}>
                        {visibleKeys.map(k => {
                          const h = healthKeyMap.get(k.id)
                          const status = h?.status ?? k.status
                          const lastChecked = h?.lastCheckedAt
                          const isEditing = editingKeyId === k.id
                          const keyCooldowns = h?.cooldowns ?? []
                          const lastCheckedLabel = lastChecked
                            ? formatSqliteUtcToLocalTime(lastChecked, { hour: '2-digit', minute: '2-digit' })
                            : null
                          const remove = () => {
                            if (confirmDeleteId === k.id) {
                              deleteKey.mutate(k.id)
                              setConfirmDeleteId(null)
                            } else {
                              setConfirmDeleteId(k.id)
                              setTimeout(() => setConfirmDeleteId(c => (c === k.id ? null : c)), 3000)
                            }
                          }
                          return (
                            <div key={k.id} className="space-y-1 rounded-lg bg-background/40 px-2 py-1.5 text-[11px]">
                              <div className="flex items-center gap-1.5">
                                <Switch
                                  className="scale-75"
                                  checked={k.enabled}
                                  onCheckedChange={(checked) => updateKey.mutate({ id: k.id, enabled: checked })}
                                  disabled={updateKey.isPending}
                                />
                                <span className={`size-1.5 shrink-0 rounded-full ${statusDot[status] ?? statusDot.unknown}`} />
                                <code className="shrink-0 truncate font-mono text-[10px]">{k.maskedKey}</code>
                                {isEditing ? (
                                  <Input
                                    ref={editInputRef}
                                    value={editingLabel}
                                    onChange={e => setEditingLabel(e.target.value)}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') saveEditing(k.id)
                                      if (e.key === 'Escape') cancelEditing()
                                    }}
                                    onBlur={() => saveEditing(k.id)}
                                    className="h-6 w-[120px] text-[10px]"
                                    disabled={updateKey.isPending}
                                  />
                                ) : k.label ? (
                                  <span className="min-w-0 truncate text-[10px] text-muted-foreground">{k.label}</span>
                                ) : null}
                                <div className="ml-auto flex items-center gap-1">
                                  {lastCheckedLabel && <span className="text-[9px] text-muted-foreground tabular-nums">{lastCheckedLabel}</span>}
                                  <span className="text-[9px] text-muted-foreground">{statusLabelKey[status] ? t(statusLabelKey[status]) : status}</span>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className={`h-5 px-1 text-[10px] ${confirmDeleteId === k.id ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}`}
                                  disabled={deleteKey.isPending}
                                  onClick={remove}
                                >
                                  {confirmDeleteId === k.id ? t('keys.confirmRemove') : t('common.remove')}
                                </Button>
                              </div>
                              {keyCooldowns.length > 0 && (
                                <div className="pl-7">
                                  <CooldownList cooldowns={keyCooldowns} compact />
                                </div>
                              )}
                            </div>
                          )
                        })}
                        {hiddenCount > 0 && (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="w-full text-[10px]"
                            onClick={() => setExpandedProviderKeys(current => ({ ...current, [group.value]: true }))}
                          >
                            {t('keys.showAllKeys', { count: hiddenCount })}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(group => (
                <div key={group.value}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={group.keys.some(k => k.enabled)}
                        onCheckedChange={(checked) =>
                          togglePlatform.mutate({ platform: group.value, enabled: checked })
                        }
                        disabled={togglePlatform.isPending}
                      />
                      <h3 className="text-sm font-medium">{group.label}</h3>
                      {proxyEnabled && (
                        <div className="inline-flex items-center gap-1.5 ml-1">
                          <span className="text-[10px] text-muted-foreground">{t('keys.proxyToggleLabel')}</span>
                          <Switch
                            checked={!bypassPlatforms.includes(group.value)}
                            onCheckedChange={() => toggleBypass.mutate(group.value)}
                            disabled={toggleBypass.isPending}
                          />
                        </div>
                      )}
                      <GetKeyLink url={group.url} />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {t(group.keys.length === 1 ? 'keys.keyCountOne' : 'keys.keyCountOther', { count: group.keys.length })}
                    </span>
                  </div>
                  <div className="rounded-2xl border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id)
                      const status = h?.status ?? k.status
                      const lastChecked = h?.lastCheckedAt
                      const isEditing = editingKeyId === k.id
                      const customModels = k.models ?? []
                      const hasCustomModels = customModels.length > 0
                      const isExpanded = expandedKeyIds.has(k.id)
                      const keyCooldowns = h?.cooldowns ?? []
                      return (
                        <div key={k.id} className="bg-card">
                          <div className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                            <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                            {hasCustomModels && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className="size-6 p-0 text-muted-foreground"
                                onClick={() => toggleExpandedKey(k.id)}
                                title={isExpanded ? t('common.hide') : t('common.show')}
                              >
                                <ChevronDown className={`size-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                              </Button>
                            )}
                            <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
                            {isEditing ? (
                              <Input
                                ref={editInputRef}
                                value={editingLabel}
                                onChange={e => setEditingLabel(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveEditing(k.id)
                                  if (e.key === 'Escape') cancelEditing()
                                }}
                                onBlur={() => saveEditing(k.id)}
                                className="h-6 w-[160px] text-xs"
                                disabled={updateKey.isPending}
                              />
                            ) : (
                              <>
                                {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                                {k.baseUrl && (
                                  <code className="text-[11px] text-muted-foreground font-mono truncate max-w-[260px]" title={k.baseUrl}>
                                    {k.baseUrl}
                                  </code>
                                )}
                              </>
                            )}
                            <span className="text-xs text-muted-foreground">{statusLabelKey[status] ? t(statusLabelKey[status]) : status}</span>
                            {keyCooldowns.length > 0 && <CooldownList cooldowns={keyCooldowns} />}
                            <div className="flex-1" />
                            {lastChecked && (
                              <span className="text-[11px] text-muted-foreground tabular-nums">
                                {formatSqliteUtcToLocalTime(lastChecked, { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            )}
                            {!isEditing && (
                              <Button variant="ghost" size="xs" onClick={() => startEditing(k)}>
                                <Pencil className="size-3" />
                              </Button>
                            )}
                            <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>
                              {t('common.check')}
                            </Button>
                            <Button
                              variant="ghost"
                              size="xs"
                              className={confirmDeleteId === k.id ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}
                              onClick={() => {
                                if (confirmDeleteId === k.id) {
                                  deleteKey.mutate(k.id)
                                  setConfirmDeleteId(null)
                                } else {
                                  setConfirmDeleteId(k.id)
                                  setTimeout(() => setConfirmDeleteId(c => (c === k.id ? null : c)), 3000)
                                }
                              }}
                              disabled={deleteKey.isPending}
                            >
                              {confirmDeleteId === k.id ? t('keys.confirmRemove') : t('common.remove')}
                            </Button>
                          </div>
                          {hasCustomModels && isExpanded && (
                            <div className="flex flex-wrap gap-2 border-t bg-muted/20 px-4 py-3 pl-12">
                              {customModels.map(model => {
                                const modelKey = customModelDeleteKey(model)
                                const confirming = confirmDeleteModelKey === modelKey
                                return (
                                  <div key={modelKey} className="inline-flex min-w-0 items-center gap-2 rounded-md border bg-background px-2 py-1 text-[11px]">
                                    <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                                      {t(CUSTOM_MODEL_KIND_LABEL[model.kind])}
                                    </span>
                                    <span className="max-w-[180px] truncate font-medium" title={model.modelId}>
                                      {model.displayName}
                                    </span>
                                    {model.family && (
                                      <code className="max-w-[160px] truncate text-muted-foreground" title={model.family}>
                                        {model.family}
                                      </code>
                                    )}
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="xs"
                                      className={`h-5 px-1 ${confirming ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}`}
                                      disabled={deleteCustomModel.isPending}
                                      onClick={() => {
                                        if (confirming) {
                                          deleteCustomModel.mutate(model)
                                          setConfirmDeleteModelKey(null)
                                        } else {
                                          setConfirmDeleteModelKey(modelKey)
                                          setTimeout(() => setConfirmDeleteModelKey(c => (c === modelKey ? null : c)), 3000)
                                        }
                                      }}
                                      title={t('common.remove')}
                                    >
                                      {confirming ? t('common.confirm') : <Trash2 className="size-3" />}
                                    </Button>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        </>
        )}
      </div>
    </div>
  )
}
