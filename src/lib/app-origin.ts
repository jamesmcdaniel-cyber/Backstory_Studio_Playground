/** Return the deployment's canonical origin without trusting the request Host header. */
export function canonicalAppOrigin(requestUrl?: string | URL): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (!configured && process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_APP_URL is required in production')
  }

  const url = new URL(configured || String(requestUrl || 'http://localhost:3000'))
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('NEXT_PUBLIC_APP_URL must use https in production')
  }
  return url.origin
}
