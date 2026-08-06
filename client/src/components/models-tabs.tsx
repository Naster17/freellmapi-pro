import { useLocation, useNavigate } from 'react-router-dom'
import { AudioLines, Image as ImageIcon, Layers, MessageSquare, Zap } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { useI18n } from '@/i18n'

const sections = [
  { id: 'chat', path: '/models/chat', match: '/models/chat', labelKey: 'models.chatModelsTab', icon: MessageSquare },
  { id: 'image', path: '/models/image', match: '/models/image', labelKey: 'models.imageTab', icon: ImageIcon },
  { id: 'audio', path: '/models/audio', match: '/models/audio', labelKey: 'models.audioTab', icon: AudioLines },
  { id: 'embeddings', path: '/models/embeddings', match: '/models/embeddings', labelKey: 'models.embeddingsTab', icon: Layers },
  { id: 'fusion', path: '/models/fusion', match: '/models/fusion', labelKey: 'models.fusionTab', icon: Zap },
]

const transcriptMatch = '/models/transcription'

export function ModelsTabs() {
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()

  const current = sections.find(section =>
    location.pathname.startsWith(section.match) || location.pathname.startsWith(transcriptMatch) && section.id === 'audio',
  ) ?? sections[0]

  const CurrentIcon = current.icon

  return (
    <Select value={current.path} onValueChange={value => { if (value) navigate(value) }}>
      <SelectTrigger aria-label={t('nav.modelsMenu')} className="gap-2">
        <CurrentIcon className="size-4" />
        <span>{t(current.labelKey)}</span>
      </SelectTrigger>
      <SelectContent align="start">
        {sections.map(section => {
          const Icon = section.icon
          return (
            <SelectItem key={section.id} value={section.path}>
              <Icon className="size-4" />
              <span>{t(section.labelKey)}</span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
