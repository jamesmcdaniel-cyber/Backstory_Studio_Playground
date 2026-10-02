import { redirect } from 'next/navigation'

// The Repository folded into Artifacts: files and structured tables are tabs
// there. Old links land on the tab they meant — a run's citation
// (/data-tables?doc=<id>) still opens that document.
export default async function DataTablesPage({ searchParams }: { searchParams: Promise<{ doc?: string | string[] }> }) {
  const { doc } = await searchParams
  const docId = Array.isArray(doc) ? doc[0] : doc
  redirect(`/artifacts?tab=files${docId ? `&doc=${encodeURIComponent(docId)}` : ''}`)
}
