export function contentSecurityPolicy(nonce: string, production = process.env.NODE_ENV === 'production'): string {
  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`]
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
