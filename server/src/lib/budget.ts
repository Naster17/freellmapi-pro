// Monthly free-tier budgets are stored as human labels like '~120M', '~50-100M',
// '~12M', or '~500K'. Parse the upper bound to an absolute token count for
// quota math (headroom guardrail, token-usage bar). Returns 0 for unknown/empty
// labels, which callers treat as "no budget info".
export function parseBudget(s: string): number {
  if (!s) return 0;
  const m = s.match(/~?([\d.]+)(?:-([\d.]+))?\s*([MK])/i);
  if (!m) return 0;
  const high = parseFloat(m[2] ?? m[1]);
  if (Number.isNaN(high)) return 0;
  const unit = m[3].toUpperCase() === 'M' ? 1_000_000 : 1_000;
  return high * unit;
}
