// script-src ceiling: pages are statically prerendered, so Next.js cannot
// inject nonces into the inline bootstrap scripts baked into the HTML at
// build time — and 'strict-dynamic' disables 'self' host allowlisting, so a
// nonce policy blocks every script on a static page (full outage 2026-08-09).
// 'unsafe-inline' stands until rendering is forced dynamic; external script
// hosts remain blocked by 'self'.
export function contentSecurityPolicy(production = process.env.NODE_ENV === 'production'): string {
  const scriptSrc = [`'self'`, `'unsafe-inline'`]
  if (!production) scriptSrc.push(`'unsafe-eval'`)
  return [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' https: wss:`,
    `media-src 'self' data: blob:`,
    `worker-src 'self' blob:`,
    `frame-src 'self'`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ')
}
