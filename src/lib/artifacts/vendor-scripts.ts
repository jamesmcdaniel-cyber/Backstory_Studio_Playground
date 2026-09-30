/**
 * Interactive artifacts render with no network access (CSP connect-src and
 * script-src limited to our own origin), so a page that loads a chart library
 * from a public CDN would render with blank charts. Known libraries are
 * served from the platform's own copies instead — the page keeps working,
 * and nothing it runs can reach the internet. Stored content is untouched;
 * the rewrite happens when the page is served.
 */

const VENDORED: Array<{ pattern: RegExp; local: string; name: string }> = [
  { name: 'Chart.js', pattern: /https?:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js(?:@4[\d.]*)?(?=["'])/gi, local: '/vendor/chart.umd.js' },
  { name: 'Chart.js', pattern: /https?:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/4[^"'\s]*|cdn\.jsdelivr\.net\/npm\/chart\.js@4[^"'\s]*|unpkg\.com\/chart\.js@4[^"'\s]*)\.js/gi, local: '/vendor/chart.umd.js' },
  { name: 'Plotly', pattern: /https?:\/\/(?:cdn\.plot\.ly\/plotly-[^"'\s]*|cdn\.jsdelivr\.net\/npm\/plotly\.js-dist-min@[^"'\s]*|cdnjs\.cloudflare\.com\/ajax\/libs\/plotly\.js\/[^"'\s]*)\.js/gi, local: '/vendor/plotly.min.js' },
  // The libraries a Claude-style page loads from a CDN (see runtime.ts for React pages).
  { name: 'React DOM', pattern: /https?:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/react-dom@1[78][^"'\s]*?\/umd\/react-dom\.[a-z.]+\.js|https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react-dom\/1[78][^"'\s]*?\/(?:umd\/)?react-dom\.[a-z.]+\.js/gi, local: '/vendor/react-dom.production.min.js' },
  { name: 'React', pattern: /https?:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/react@1[78][^"'\s]*?\/umd\/react\.[a-z.]+\.js|https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/react\/1[78][^"'\s]*?\/(?:umd\/)?react\.[a-z.]+\.js/gi, local: '/vendor/react.production.min.js' },
  { name: 'PropTypes', pattern: /https?:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/prop-types@[^"'\s]*?\/prop-types(?:\.min)?\.js|https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/prop-types\/[^"'\s]*?\/prop-types(?:\.min)?\.js/gi, local: '/vendor/prop-types.min.js' },
  { name: 'Recharts', pattern: /https?:\/\/(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/recharts@2[^"'\s]*?\/umd\/Recharts(?:\.min)?\.js|https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/recharts\/2[^"'\s]*?\/Recharts(?:\.min)?\.js/gi, local: '/vendor/recharts.min.js' },
  { name: 'd3', pattern: /https?:\/\/(?:cdn\.jsdelivr\.net\/npm\/d3@7(?:\.[\d.]+)?(?=["'])|d3js\.org\/d3\.v7(?:\.min)?\.js|(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/d3@7[^"'\s]*?\/dist\/d3(?:\.min)?\.js|cdnjs\.cloudflare\.com\/ajax\/libs\/d3\/7[^"'\s]*?\/d3(?:\.min)?\.js)/gi, local: '/vendor/d3.min.js' },
  { name: 'lodash', pattern: /https?:\/\/(?:(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/lodash@4[^"'\s]*?\/lodash(?:\.min)?\.js|cdnjs\.cloudflare\.com\/ajax\/libs\/lodash\.js\/4[^"'\s]*?\/lodash(?:\.min)?\.js)/gi, local: '/vendor/lodash.min.js' },
  { name: 'three.js', pattern: /https?:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/[^"'\s]*?\/three(?:\.min)?\.js|(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/three@0\.1[0-5]\d[^"'\s]*?\/build\/three(?:\.min)?\.js)/gi, local: '/vendor/three.min.js' },
  { name: 'Mermaid', pattern: /https?:\/\/(?:(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/mermaid@(?:9|10|11)[^"'\s]*?\/dist\/mermaid(?:\.min)?\.js|cdnjs\.cloudflare\.com\/ajax\/libs\/mermaid\/[^"'\s]*?\/mermaid(?:\.min)?\.js)/gi, local: '/vendor/mermaid.min.js' },
  { name: 'SheetJS', pattern: /https?:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/[^"'\s]*?|(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/xlsx@[^"'\s]*?\/dist|cdn\.sheetjs\.com\/xlsx-[^"'\s]*?\/package\/dist)\/xlsx\.full\.min\.js/gi, local: '/vendor/xlsx.full.min.js' },
  { name: 'PapaParse', pattern: /https?:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/PapaParse\/[^"'\s]*?|(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/papaparse@[^"'\s]*?)\/papaparse(?:\.min)?\.js/gi, local: '/vendor/papaparse.min.js' },
  { name: 'math.js', pattern: /https?:\/\/(?:cdnjs\.cloudflare\.com\/ajax\/libs\/mathjs\/[^"'\s]*?\/math(?:\.min)?\.js|(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/mathjs@[^"'\s]*?\/lib\/browser\/math\.js)/gi, local: '/vendor/math.min.js' },
  { name: 'marked', pattern: /https?:\/\/(?:(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/marked(?:@[^"'\s\/]*)?\/(?:lib\/)?marked(?:\.umd)?(?:\.min)?\.js|cdnjs\.cloudflare\.com\/ajax\/libs\/marked\/[^"'\s]*?\/marked(?:\.min)?\.js)/gi, local: '/vendor/marked.min.js' },
  { name: 'Tailwind', pattern: /https?:\/\/(?:cdn\.tailwindcss\.com(?:\/[^"'\s]*)?(?:\?[^"'\s]*)?|(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/@tailwindcss\/browser@4[^"'\s]*)(?=["'])/gi, local: '/vendor/tailwind.browser.js' },
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
