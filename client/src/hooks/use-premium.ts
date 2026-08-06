import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

export interface LicenseStatus {
  valid: boolean
  plan: 'annual' | 'lifetime' | null
  status: string | null
  expiresAt: string | null
  cancelAtPeriodEnd?: boolean
  reason?: string
  checkedAtMs: number
}

export interface CatalogSnapshotSummary {
  version: string
  generatedAt: string
  tier: 'live' | 'monthly'
  totalModels: number
  enabledModels: number
  platforms: number
  quirks: number
}

export interface CatalogModelChange {
  key: string
  platform: string
  modelId: string
  displayName: string
  fields: string[]
}

export interface CatalogDiffSummary {
  hasPrevious: boolean
  fromVersion: string | null
  fromTier: 'live' | 'monthly' | null
  toVersion: string
  toTier: 'live' | 'monthly'
  added: CatalogModelChange[]
  removed: CatalogModelChange[]
  changed: CatalogModelChange[]
  quirks: { added: string[]; removed: string[]; changed: string[] }
  counts: {
    added: number
    removed: number
    changed: number
    quirksAdded: number
    quirksRemoved: number
    quirksChanged: number
  }
}

export interface CatalogSyncState {
  source: 'freellmapi.co' | 'naster17'
  baseUrl: string
  appliedVersion: string | null
  appliedTier: string | null
  appliedSource: string | null
  lastSyncMs: number | null
  lastError: string | null
  snapshot: CatalogSnapshotSummary | null
  changes: CatalogDiffSummary | null
}

export interface PremiumStatus {
  hasKey: boolean
  maskedKey: string | null
  license: LicenseStatus | null
  catalog: CatalogSyncState
  siteUrl: string
}

export function usePremium() {
  const query = useQuery<PremiumStatus>({
    queryKey: ['premium'],
    queryFn: () => apiFetch('/api/premium'),
  })

  return {
    ...query,
    licensed: Boolean(query.data?.hasKey && query.data.license?.valid),
  }
}
