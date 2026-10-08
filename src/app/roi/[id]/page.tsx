import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { requireAuthContext } from '@/lib/server/auth'

// Old /roi/:analysisId links (notifications, bookmarks) open the ROI page on
// that run's account. The page is the one place the report lives now; the
// artifact behind it carries versions and sharing, which stay off /roi.
export default async function RoiAnalysisRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await requireAuthContext().catch(() => null)
  if (!auth) redirect('/roi')
  const row = await prisma.roiAnalysis.findFirst({ where: { id, organizationId: auth.organizationId }, select: { account: true } })
  redirect(row?.account ? `/roi?account=${encodeURIComponent(row.account)}` : '/roi')
}
