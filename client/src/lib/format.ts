export function formatTokens(n?: number | null): string {
  if (!n) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  if (!Number.isInteger(n)) return n.toFixed(1)
  return String(n)
}

export function formatCount(n?: number | null): string {
  if (!n) return '0'
  return new Intl.NumberFormat().format(n)
}

export function formatLatency(ms?: number | null): string {
  if (!ms || ms <= 0) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
  return `${Math.round(ms)}ms`
}

export function formatPercent(value?: number | null): string {
  return value == null ? '—' : `${Math.round(value * 10) / 10}%`
}
