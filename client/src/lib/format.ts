const TOKEN_UNITS: Array<[number, string]> = [
  [1e15, 'Q'],
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
]

export function formatTokens(n?: number | null): string {
  if (!n) return '0'
  const unit = TOKEN_UNITS.find(([limit]) => n >= limit)
  if (!unit) return Number.isInteger(n) ? String(n) : n.toFixed(1)
  return `${(n / unit[0]).toFixed(1).replace(/\.0$/, '')}${unit[1]}`
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
