import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireAuthContext } from '@/lib/server/auth'

// Old /roi/:analysisId links (notifications, bookmarks) open the analysis's
// artifact, which is where its dashboard, versions and assistant now live.
export default async function RoiAnalysisRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireAuthContext().catch(() => null)
  if (!auth) redirect('/artifacts')
  const row = await prisma.roiAnalysis.findFirst({ where: { id, organizationId: auth.organizationId }, select: { artifactId: true } })
  redirect(row?.artifactId ? `/artifacts/${row.artifactId}` : '/artifacts?kind=roi_dashboard')
}
