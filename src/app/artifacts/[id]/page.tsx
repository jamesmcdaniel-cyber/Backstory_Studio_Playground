'use client'

import { useParams } from 'next/navigation'
import { ArtifactViewer } from '@/components/artifacts/artifact-viewer'

export default function ArtifactPage() {
  const params = useParams<{ id: string }>()
  return <ArtifactViewer id={params.id} />
}
