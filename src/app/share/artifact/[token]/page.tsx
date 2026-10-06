import { cookies, headers } from 'next/headers'
import { prisma, systemPrisma } from '@/lib/prisma'
import { resolvePublicArtifact } from '@/lib/artifacts/sharing'
import { looksLikeHtml } from '@/lib/html-detect'
import { Markdown } from '@/components/ui/markdown'
import { ARTIFACT_FRAME_SANDBOX } from '@/components/artifacts/artifact-frame'
import { GUEST_COOKIE } from '@/lib/artifacts/types'
import { SharedTemplateCopilot, type TemplateCopy } from '@/components/artifacts/shared-template-copilot'
import { requireAuthContext } from '@/lib/server/auth'
import { loadArtifact } from '@/lib/artifacts/service'
import { artifactPermissions } from '@/lib/artifacts/sharing'
import { viewerOf } from '@/lib/artifacts/route-access'
import { findArtifactTemplateCopy, loadGuestCopy, templateCopyUpdate } from '@/lib/artifacts/templates'

/**
 * The copy this visitor already has of a template link, resolved before the
 * page is sent so it opens on their latest version — never on the original
 * first and their changes a moment later. Looking never creates a copy.
 */
async function existingCopy(token: string): Promise<TemplateCopy | null> {
  try {
    // Signed in: their own copy, in their workspace.
    const auth = await requireAuthContext().catch(() => null)
    if (auth?.can('agent.read')) {
      const copy = await findArtifactTemplateCopy(token, auth.organizationId, auth.dbUser.id)
      if (!copy) return null
      const [artifact, row, sharedUpdate] = await Promise.all([
        loadArtifact(auth.organizationId, copy.id),
        prisma.artifact.findFirst({ where: { id: copy.id, organizationId: auth.organizationId }, select: { userId: true, workspaceAccess: true, editorIds: true, templateSourceId: true } }),
        templateCopyUpdate(token, auth.organizationId, copy.id),
      ])
      return artifact && row ? { kind: 'member', id: copy.id, artifact: { ...artifact, permissions: artifactPermissions(viewerOf(auth), row) }, sharedUpdate } : null
    }
    // No account: the guest copy this browser's cookie opens.
    const guestToken = (await cookies()).get(GUEST_COOKIE)?.value
    const view = guestToken ? await loadGuestCopy(token, guestToken) : null
    return view ? { kind: 'guest', view } : null
  } catch {
    return null // the original is still a page worth showing
  }
}

export const dynamic = 'force-dynamic'
export const metadata = { robots: { index: false, follow: false } }

/**
 * An artifact's public link: its current version, live and view-only, for
 * someone with no account. The page is framed from the public content route
 * (same sandbox as the app); a Markdown document renders here. Nothing else
 * of the workspace is reachable from it. A link offered as a template also
 * carries the copilot, which works on the visitor's own copy — no account
 * needed.
 */
function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/30 p-6">
      <div className="max-w-md rounded-2xl border border-border/60 bg-card p-8 text-center shadow-1">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

export default async function PublicArtifactPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const headerList = await headers()
  const clientKey = headerList.get('x-forwarded-for')?.split(',')[0]?.trim() || headerList.get('x-real-ip') || 'unknown'
  const result = await resolvePublicArtifact(token, { clientKey, countView: true })
  if (result.status === 'rate_limited') return <Notice title="Too many requests" body="Give it a minute and try the link again." />
  if (result.status === 'expired') return <Notice title="This link has expired" body="Whoever shared it set it to stop working after a certain date. Ask them for a new link." />
  if (result.status === 'not_found') return <Notice title="This link isn’t available" body="It may have been turned off or replaced. Ask whoever sent it for a new one." />

  const { artifact } = result
  // systemPrisma: the organization comes from the link just resolved.
  const version = artifact.currentVersionId
    ? await systemPrisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId: artifact.organizationId }, select: { content: true } })
    : null
  if (!version) return <Notice title="Nothing to show yet" body="This artifact has no content yet." />
  const isPage = looksLikeHtml(version.content.slice(0, 4_000))

  // Someone who has changed their copy of this template opens straight onto it.
  const copy = artifact.shareTemplate ? await existingCopy(token) : null

  // No chrome of ours: the artifact is the page. A template adds only the
  // copilot launcher, which opens the visitor's own copy in place.
  const original = isPage ? (
    <iframe
      title={artifact.title}
      src={`/api/share/artifacts/${token}/content`}
      sandbox={ARTIFACT_FRAME_SANDBOX}
      className="block h-dvh w-full border-0"
    />
  ) : (
    <div className="prose prose-sm mx-auto w-full max-w-3xl p-6 dark:prose-invert">
      <Markdown>{version.content}</Markdown>
    </div>
  )

  return (
    <div className="min-h-dvh bg-background">
      <h1 className="sr-only">{artifact.title}</h1>
      {artifact.shareTemplate ? <SharedTemplateCopilot token={token} isPage={isPage} initialCopy={copy}>{original}</SharedTemplateCopilot> : original}
    </div>
  )
}
