import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { Anonymous_Pro } from 'next/font/google'
import { ClientProviders } from '@/components/providers/client-providers'
import { AppShell } from '@/components/layout/app-shell'
import './globals.css'

// PRIMARY DISPLAY/BODY — KMR Waldenburg (proprietary, self-hosted). Arimo is the
// brand's metric-compatible Google alternate and sits in the fallback chain.
const waldenburg = localFont({
  src: [
    { path: '../../public/fonts/kmrwaldenburg-light.ttf', weight: '300', style: 'normal' },
    { path: '../../public/fonts/kmrwaldenburg-regular.ttf', weight: '400', style: 'normal' },
    { path: '../../public/fonts/kmrwaldenburg-italic.ttf', weight: '400', style: 'italic' },
    { path: '../../public/fonts/kmrwaldenburg-medium.ttf', weight: '500', style: 'normal' },
    { path: '../../public/fonts/kmrwaldenburg-bold.ttf', weight: '700', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'swap',
  fallback: ['Arimo', 'system-ui', 'sans-serif'],
})

// PRIMARY MONO — Anonymous Pro (brand tagline + uppercase micro-labels).
const anonymousPro = Anonymous_Pro({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Backstory',
  description: 'Build, run, and review AI agents connected to your tools.',
}

/**
 * Every page renders per-request so the CSP nonce can be stamped onto Next's
 * inline bootstrap scripts.
 *
 * A statically prerendered page is HTML built before any request exists, so
 * there is no per-request nonce to put in it — Chrome refuses its inline scripts
 * outright and the page renders blank under the enforced policy. (Verified: the
 * static routes served 0 nonces while the dynamic ones served theirs correctly.)
 * This is the documented Next.js consequence of nonce-based CSP, not a
 * workaround.
 *
 * The cost is small here: src/lib/supabase/middleware.ts already sends
 * `Cache-Control: no-store` on every non-public page, so the authenticated
 * surface was never being served from a cache anyway — prerendering only saved
 * server render time on a shell whose data all arrives via API calls. The
 * marketing pages ('/', '/privacy', '/terms') give up static prerender, which is
 * the real trade, accepted so the whole origin gets one strict policy rather
 * than a strong policy on some paths and 'unsafe-inline' on others.
 */
export const dynamic = 'force-dynamic'

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${waldenburg.variable} ${anonymousPro.variable}`}>
      <body>
        <ClientProviders>
          <AppShell>{children}</AppShell>
        </ClientProviders>
      </body>
    </html>
  )
}
