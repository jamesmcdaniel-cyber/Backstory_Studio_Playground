import { notFound } from 'next/navigation'
import { systemPrisma } from '@/lib/prisma'
import { hostedFormDefinition } from '@/lib/flows/form'
import { HostedForm } from '@/components/forms/hosted-form'

export default async function PublicHostedFormPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  // systemPrisma: public hosted-form lookup has no session/org context; the
  // globally unique flow id is only usable when the published trigger says form.
  const flow = await systemPrisma.flow.findFirst({
    where: { id, status: 'ACTIVE' },
    select: { id: true, name: true, trigger: true, publishedGraph: true },
  })
  const definition = flow ? hostedFormDefinition(flow.name, flow.trigger) : null
  if (!flow?.publishedGraph || !definition) notFound()
  return (
    <div className="min-h-dvh bg-gradient-to-b from-horizon-50/70 to-background px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-xl rounded-2xl border bg-card p-6 shadow-3 sm:p-9">
        <HostedForm flowId={flow.id} definition={definition} />
      </div>
    </div>
  )
}
