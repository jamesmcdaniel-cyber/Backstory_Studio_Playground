import { NextResponse, type NextRequest } from 'next/server'
import { systemPrisma } from '@/lib/prisma'
import { resolvePublicArtifact } from '@/lib/artifacts/sharing'
import { artifactPageResponse } from '@/lib/artifacts/serve'
import { clientIp } from '@/lib/security/events'

export const runtime = 'nodejs'

// GET /api/share/artifacts/:token/content — the current version of an
// artifact whose public link is on, for someone with no session. Served by
// the same function and sandbox as the in-app viewer; the token is the only
// credential (digest lookup, rate-limited, off the moment the link is).
export async function GET(request: NextRequest) {
  const token = request.nextUrl.pathname.split('/').at(-2) ?? ''
  const result = await resolvePublicArtifact(token, { clientKey: clientIp(request) ?? 'unknown' })
  if (result.status === 'rate_limited') return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  if (result.status === 'not_found' || !result.artifact.currentVersionId) return NextResponse.json({ error: 'This link is not available.' }, { status: 404 })
  // systemPrisma: resolved above from the link, which carries the organization.
  const version = await systemPrisma.artifactVersion.findFirst({
    where: { id: result.artifact.currentVersionId, organizationId: result.artifact.organizationId },
    select: { content: true },
  })
  if (!version) return NextResponse.json({ error: 'This link is not available.' }, { status: 404 })
  return artifactPageResponse({ content: version.content, kind: result.artifact.kind }, request.nextUrl.origin)
}
