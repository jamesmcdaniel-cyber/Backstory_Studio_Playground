import { cookies, headers } from 'next/headers'
import { systemPrisma } from '@/lib/prisma'
import { resolvePublicArtifact } from '@/lib/artifacts/sharing'
import { looksLikeHtml } from '@/lib/html-detect'
import { Markdown } from '@/components/ui/markdown'
import { ARTIFACT_FRAME_SANDBOX } from '@/components/artifacts/artifact-frame'
import { GUEST_COOKIE } from '@/lib/artifacts/types'
import { SharedTemplateCopilot } from '@/components/artifacts/shared-template-copilot'

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
  if (result.status === 'not_found') return <Notice title="This link isn’t available" body="It may have been turned off or replaced. Ask whoever sent it for a new one." />

  const { artifact } = result
  // systemPrisma: the organization comes from the link just resolved.
  const version = artifact.currentVersionId
    ? await systemPrisma.artifactVersion.findFirst({ where: { id: artifact.currentVersionId, organizationId: artifact.organizationId }, select: { content: true } })
    : null
  if (!version) return <Notice title="Nothing to show yet" body="This artifact has no content yet." />
  const isPage = looksLikeHtml(version.content.slice(0, 4_000))

  // A visitor who has used a copilot before may have a copy of this one.
  const returning = artifact.shareTemplate && (await cookies()).has(GUEST_COOKIE)

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
      {artifact.shareTemplate ? <SharedTemplateCopilot token={token} isPage={isPage} returning={returning}>{original}</SharedTemplateCopilot> : original}
    </div>
  )
}
