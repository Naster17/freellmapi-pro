export function getBudgetScore(model: { monthly_token_budget: string; tpd_limit: number | null }): number {
  if (model.tpd_limit != null) return model.tpd_limit * 30;

  const budget = model.monthly_token_budget;
  if (!budget) return 0;
  if (budget.toLowerCase().includes('unlimited') || budget.includes('∞')) return Infinity;

  const cleanBudget = budget.split('(')[0];
  const matches = cleanBudget.match(/[\d.]+/g);
  const maxNum = matches ? Math.max(...matches.map(value => parseFloat(value))) : 0;

  let multiplier = 1;
  const upper = cleanBudget.toUpperCase();
  if (upper.includes('B')) multiplier = 1_000_000_000;
  else if (upper.includes('M')) multiplier = 1_000_000;
  else if (upper.includes('K')) multiplier = 1_000;

  return maxNum * multiplier;
}
