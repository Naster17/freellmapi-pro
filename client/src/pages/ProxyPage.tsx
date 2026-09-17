import { PageHeader } from '@/components/page-header'
import { ProxyTab } from '@/components/keys/proxy-tab'
import { useI18n } from '@/i18n'

export default function ProxyPage() {
  const { t } = useI18n()
  return (
    <div className="space-y-8">
      <PageHeader
        title={t('nav.proxy')}
        description={t('keys.outboundProxyDescription')}
      />
      <ProxyTab />
    </div>
  )
}
