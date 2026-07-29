import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, ExternalLink } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { PageHeader } from '@/components/page-header'
import { CopyButton } from '@/components/copy-button'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import toolCatalog from '@/data/agent-tools.json'

interface ClientAnalytics {
  clientAgent: string
  requests: number
  lastSeenAt: string | null
}

interface KeyResponse {
  apiKey: string
}

const analyticsIds: Record<string, string> = {
  claude: 'claude-code',
  codex: 'codex',
  cline: 'cline',
  continue: 'continue',
  aider: 'aider',
  opencode: 'opencode',
  goose: 'goose',
  qwen: 'qwen-code',
  roo: 'roo',
  kilo: 'kilo-code',
  crush: 'crush',
  cursor: 'cursor',
}

function masked(value: string): string {
  if (value.length < 12) return '••••••••'
  return `${value.slice(0, 8)}${'•'.repeat(12)}${value.slice(-4)}`
}

export default function AgentsPage() {
  const { t } = useI18n()
  const [revealKey, setRevealKey] = useState(false)
  const { data: keyData } = useQuery<KeyResponse>({
    queryKey: ['api-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })
  const { data: byClient = [] } = useQuery<ClientAnalytics[]>({
    queryKey: ['analytics', 'by-client', '30d'],
    queryFn: () => apiFetch('/api/analytics/by-client?range=30d'),
  })
  // "Seen recently" means traffic within the last 7 days, not merely any row
  // in the fetched 30-day window.
  const seenCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  const seen = new Map(byClient
    .filter(row => row.lastSeenAt && Date.parse(row.lastSeenAt) >= seenCutoff)
    .map(row => [row.clientAgent, row]))
  const origin = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}`
    : window.location.origin
  const shownKey = keyData?.apiKey
    ? (revealKey ? keyData.apiKey : masked(keyData.apiKey))
    : '…'

  return (
    <div>
      <PageHeader
        title={t('agents.title')}
        description={t('agents.description')}
        actions={
          <Button variant="outline" size="sm" onClick={() => setRevealKey(value => !value)}>
            {revealKey ? t('common.hide') : t('common.show')} {t('agents.apiKey')}
          </Button>
        }
      />

      <div className="mb-6 rounded-3xl border bg-card p-4">
        <p className="text-xs text-muted-foreground">{t('agents.quickstart')}</p>
        <div className="mt-2 flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2">
          <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">
            npx freellmapi setup-claude --url {origin}
          </code>
          <CopyButton
            text={`npx freellmapi setup-claude --url ${origin}`}
            className="size-7 shrink-0"
            label={t('common.copy')}
          />
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{t('agents.currentKey')}</span>
          <code className="font-mono">{shownKey}</code>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {toolCatalog.map(tool => {
          const traffic = seen.get(analyticsIds[tool.id] ?? tool.id)
          const command = `npx freellmapi ${tool.command} --url ${origin}`
          const endpoint = tool.baseUrlSupport === 'root' ? origin : `${origin}/v1`
          // The copied snippet is pasted into config files — keep it
          // locale-independent.
          const realConnection = `BASE_URL=${endpoint}\nAPI_KEY=${keyData?.apiKey ?? '<unified-key>'}`
          const shownConnection = `BASE_URL=${endpoint}\nAPI_KEY=${shownKey}`
          return (
            <Card key={tool.id} size="sm">
              <CardHeader>
                <div
                  className="mb-2 flex size-9 items-center justify-center rounded-xl bg-muted font-mono text-[11px] font-semibold"
                  aria-hidden="true"
                >
                  {tool.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()}
                </div>
                <CardTitle>{tool.name}</CardTitle>
                <CardDescription>{tool.protocol} · {tool.baseUrlSupport}</CardDescription>
                <CardAction>
                  {traffic && (
                    <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 />
                      {t('agents.seenRecently')}
                    </Badge>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{command}</code>
                  <CopyButton text={command} className="size-7 shrink-0" label={t('common.copy')} />
                </div>
                <div className="flex items-start gap-2 rounded-xl border px-3 py-2">
                  <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px]">
                    {shownConnection}
                  </code>
                  <CopyButton
                    text={realConnection}
                    className="size-7 shrink-0"
                    label={t('common.copy')}
                  />
                </div>
                <a
                  href={tool.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  {t('agents.documentation')} <ExternalLink className="size-3" />
                </a>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
