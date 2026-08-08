'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertCircle, Cable, CheckCircle2, Server } from 'lucide-react'
import { McpServersPanel } from '@/components/integrations/mcp-servers-panel'
import { PageHeader } from '@/components/ui/page-header'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { OAuthIntegrationsGrid } from './oauth-integrations-grid'

type IntegrationsTab = 'integrations' | 'servers'

function tabFromParam(value: string | null): IntegrationsTab {
  if (value === 'servers') return 'servers'
  return 'integrations'
}

function IntegrationsTabs() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeTab = tabFromParam(searchParams.get('tab'))
  const oauthError = searchParams.get('error')
  const oauthConnected = searchParams.get('connected') === '1'
  const oauthErrorMessage =
    oauthError === 'oauth_start'
      ? 'OAuth could not start. Verify the MCP URL and that the server supports dynamic client registration.'
      : oauthError === 'oauth_state'
        ? 'OAuth expired or failed its security check. Start the connection again.'
        : oauthError
          ? 'OAuth did not complete. Check the server configuration and try again.'
          : null

  const handleTabChange = (value: string) => {
    const href = value === 'integrations' ? '/integrations' : `/integrations?tab=${value}`
    router.replace(href, { scroll: false })
  }

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="integrations"><Cable className="mr-2 h-4 w-4" />Integrations</TabsTrigger>
        <TabsTrigger value="servers"><Server className="mr-2 h-4 w-4" />MCP Servers</TabsTrigger>
      </TabsList>
      <TabsContent value="integrations" className="mt-6 space-y-8">
        {/* Backstory Sales AI (MCP) connects on the MCP servers tab. Granola,
            the Slack bot token and the Resend key are workspace keys, managed
            in Settings — keeping password-type inputs off this page also keeps
            Chrome's password manager from autofilling the search bar. */}
        <Suspense fallback={<p className="text-sm text-gray-500">Loading integrations...</p>}>
          <OAuthIntegrationsGrid />
        </Suspense>
      </TabsContent>
      <TabsContent value="servers" className="mt-6">
        {oauthConnected && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            OAuth completed and the MCP server handshake was verified.
          </div>
        )}
        {oauthErrorMessage && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {oauthErrorMessage}
          </div>
        )}
        <McpServersPanel returnTo="/integrations?tab=servers" />
      </TabsContent>
    </Tabs>
  )
}

export default function IntegrationsPage() {
  return (
    <>
      <div className="space-y-6">
        <PageHeader
          eyebrow="Connections"
          title="Integrations"
          description="Connect your accounts with Nango or bring your own MCP servers."
        />
        <Suspense fallback={null}>
          <IntegrationsTabs />
        </Suspense>
      </div>
    </>
  )
}
