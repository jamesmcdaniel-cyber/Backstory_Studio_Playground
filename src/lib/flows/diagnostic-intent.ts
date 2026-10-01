/** Only explicit diagnosis-only requests use the deterministic fast path.
 * Mixed requests ("check and fix") still reach the edit model. */
export function isDiagnosisOnly(message: string): boolean {
  const text = message.trim().toLowerCase().replace(/[?.!]+$/, '')
  return /^(?:check|validate|diagnose|audit)(?: this| the| my)? (?:flow|workflow)(?: for (?:errors|gaps|issues|blockers))?$/.test(text)
    || /^(?:what(?:'s| is) wrong with|why (?:won't|can't) (?:this|my)) (?:flow|workflow)(?: run)?$/.test(text)
}
