'use client'

import { Toaster } from 'sonner'
import { MotionConfig } from 'motion/react'
import { SupabaseProvider } from './supabase-provider'
import { ProposalsProvider } from './proposals-provider'
import { AuthSeedProvider } from '@/hooks/use-auth'
import type { AuthSeed } from '@/hooks/auth-context-state'

export function ClientProviders({ children, authSeed = null }: { children: React.ReactNode; authSeed?: AuthSeed | null }) {
  return (
    <MotionConfig reducedMotion="user">
      <SupabaseProvider>
        <AuthSeedProvider seed={authSeed}>
          <ProposalsProvider>
            {children}
          </ProposalsProvider>
        </AuthSeedProvider>
        <Toaster
          richColors
          position="bottom-right"
          toastOptions={{
            classNames: {
              toast:
                'rounded-lg border border-border bg-background text-foreground shadow-3 font-sans',
              description: 'text-muted-foreground',
              actionButton: 'bg-primary text-primary-foreground',
              cancelButton: 'bg-muted text-muted-foreground',
            },
          }}
        />
      </SupabaseProvider>
    </MotionConfig>
  )
}
