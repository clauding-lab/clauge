/**
 * API replacement value (the metric we display as "ROI") per PRD v3.1 §2.6.
 *
 * Honest framing — this answers "how much retail API spend does your
 * subscription replace at observed token usage?", NOT "is your plan worth
 * keeping?". Most users would cut back if they paid retail per token.
 */

export function apiReplacementValue({
  apiEquivalentSpend,
  subscriptionCost,
  extraUsageSpend = 0,
}) {
  const sub = (subscriptionCost ?? 0) + extraUsageSpend;
  const replacement = (apiEquivalentSpend ?? 0) - sub;
  const roiPct = sub === 0 ? null : (replacement / sub) * 100;
  return {
    apiEquivalentSpend: apiEquivalentSpend ?? 0,
    subscriptionCost: subscriptionCost ?? 0,
    extraUsageSpend,
    totalSubscriptionOutlay: sub,
    apiReplacementValue: replacement,
    roiPct,
  };
}

/**
 * Sum costs across summarized sessions.
 */
export function sumSessionCosts(sessions) {
  let sum = 0;
  for (const s of sessions ?? []) sum += s?.cost ?? 0;
  return sum;
}
