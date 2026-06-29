import { PageHeader } from '@/components/page-header'
import { RouterBehaviorSection } from '@/components/settings/router-behavior-section'
import { ContextHandoffSection } from '@/components/settings/context-handoff-section'
import { AnalyticsRetentionSection } from '@/components/settings/analytics-retention-section'
import { UnifySection } from '@/components/settings/unify-section'
import { useI18n } from '@/i18n'

export default function SettingsPage() {
  const { t } = useI18n()

  return (
    <div>
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      <div className="space-y-6">
        <RouterBehaviorSection />
        <ContextHandoffSection />
        <AnalyticsRetentionSection />
        <UnifySection />
      </div>
    </div>
  )
}
