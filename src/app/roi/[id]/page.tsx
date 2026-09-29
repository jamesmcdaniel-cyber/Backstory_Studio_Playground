'use client'

import { useParams } from 'next/navigation'
import { AnalysisView } from '@/components/roi/analysis-view'

export default function RoiAnalysisPage() {
  const params = useParams<{ id: string }>()
  return <AnalysisView id={params.id} />
}
