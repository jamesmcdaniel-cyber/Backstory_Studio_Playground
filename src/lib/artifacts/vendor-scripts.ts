/**
 * Interactive artifacts render with no network access (CSP connect-src and
 * script-src limited to our own origin), so a page that loads a chart library
 * from a public CDN would render with blank charts. Known libraries are
 * served from the platform's own copies instead — the page keeps working,
 * and nothing it runs can reach the internet. Stored content is untouched;
 * the rewrite happens when the page is served.
 */

const VENDORED: Array<{ pattern: RegExp; local: string; name: string }> = [
  { name: 'Chart.js', pattern: /https?:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/4[^"'\s]*|cdn\.jsdelivr\.net\/npm\/chart\.js@4[^"'\s]*|unpkg\.com\/chart\.js@4[^"'\s]*)\.js/gi, local: '/vendor/chart.umd.js' },
  { name: 'Plotly', pattern: /https?:\/\/(?:cdn\.plot\.ly\/plotly-[^"'\s]*|cdn\.jsdelivr\.net\/npm\/plotly\.js-dist-min@[^"'\s]*|cdnjs\.cloudflare\.com\/ajax\/libs\/plotly\.js\/[^"'\s]*)\.js/gi, local: '/vendor/plotly.min.js' },
]

export function vendorScripts(html: string): string {
  let out = html
  for (const lib of VENDORED) out = out.replace(lib.pattern, lib.local)
  return out
}

/** External scripts a page loads that we do NOT serve locally — they will not run. */
export function unsupportedScripts(html: string): string[] {
  const vendored = vendorScripts(html)
  const found = [...vendored.matchAll(/<script[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1])
  return [...new Set(found)]
}
