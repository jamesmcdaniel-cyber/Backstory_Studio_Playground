'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination, paginate } from '@/components/ui/pagination'
import { StaggerItem, StaggerReveal } from '@/components/ui/motion-primitives'
import { FlowTemplateCard, type FlowTemplateItem } from '@/components/templates/flow-template-card'
import { LibraryFilterBar, ALL_FILTER } from '@/components/templates/library-filter-bar'
import { accentFor } from '@/components/templates/accents'
import { hasRole } from '@/lib/templates/roles'
import { createFlowFromTemplate } from '@/lib/client/flow-from-template'

/** Cards per page — same rhythm as the flows grid above the gallery. */
const PAGE_SIZE = 9

/**
 * The full flow-template catalogue, on the Flows page itself: every template
 * (built-in, community, and AI-suggested), searchable and paged.
 * This replaced both the six-card teaser strip and the Flows tab that used to
 * live under Agents → Templates — one surface, no round-trip to another page
 * to see the rest of the library.
 */
export function FlowTemplateGallery() {
  const router = useRouter()
  const [templates, setTemplates] = useState<FlowTemplateItem[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState(ALL_FILTER)
  const [role, setRole] = useState(ALL_FILTER)
  const [page, setPage] = useState(1)
  // Which template card is mid-instantiate, so only that card spins.
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FlowTemplateItem | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/flow-templates', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !data.success) return
        // Flatten to the card shape here: the wire payload carries the whole
        // graph and notes, which the grid has no use for.
        setTemplates(
          (data.templates || []).map((entry: Record<string, any>): FlowTemplateItem => ({
            id: entry.id,
            name: entry.name,
            description: entry.description,
            category: entry.category,
            icon: entry.icon,
            integrations: entry.integrations,
            tags: entry.tags,
            stepCount: entry.stepCount ?? 0,
            setupCount: (entry.bindings?.length ?? 0) + (entry.notes?.setup?.length ?? 0),
            custom: entry.custom,
            mine: entry.mine,
            source: entry.source,
          })),
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const useTemplate = async (template: FlowTemplateItem) => {
    setPendingId(template.id)
    try {
      const result = await createFlowFromTemplate(template.id)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success(result.message)
      router.push(result.href)
    } finally {
      setPendingId(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      const response = await fetch('/api/flow-templates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deleteTarget.id }),
      })
      if (!response.ok) {
        toast.error('Could not remove the template.')
        return
      }
      setTemplates((prev) => prev.filter((entry) => entry.id !== deleteTarget.id))
      toast.success('Removed from the flow library.')
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }

  if (templates.length === 0) return null

  // Search is a substring across everything a user might remember a template by
  // (name, description, category, tags, and required integrations), so nobody
  // pages through the library hunting for "renewal" or "slack". Category and
  // role narrow it further, from the same bar the Templates library uses.
  const q = search.trim().toLowerCase()
  const categories = Array.from(new Set(templates.map((t) => t.category).filter(Boolean))).sort()
  const visible = templates.filter(
    (t) =>
      (!q ||
        [t.name, t.description, t.category, ...(t.tags ?? []), ...(t.integrations ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(q)) &&
      (category === ALL_FILTER || t.category === category) &&
      hasRole(t, role),
  )
  // Every filter returns to page one — a narrower result set otherwise leaves
  // you on a page that no longer exists.
  const onSearch = (value: string) => { setSearch(value); setPage(1) }
  const onCategory = (value: string) => { setCategory(value); setPage(1) }
  const onRole = (value: string) => { setRole(value); setPage(1) }
  const filtering = q !== '' || category !== ALL_FILTER || role !== ALL_FILTER
  const clearFilters = () => { setSearch(''); setCategory(ALL_FILTER); setRole(ALL_FILTER); setPage(1) }
  const { pageItems, pageCount, page: current } = paginate(visible, page, PAGE_SIZE)

  return (
    <section className="space-y-4 border-t border-border/60 pt-6">
      <div>
        <h2 className="text-2xl font-bold leading-9 tracking-tight text-foreground">Start from a template</h2>
        <p className="text-sm text-muted-foreground">
          Complete pipelines, wired and explained step by step. Use one and it lands as a draft you can read before it runs.
        </p>
      </div>

      <LibraryFilterBar
        search={search}
        onSearchChange={onSearch}
        searchPlaceholder="Search templates…"
        searchLabel="Search flow templates"
        categories={categories}
        category={category}
        onCategoryChange={onCategory}
        role={role}
        onRoleChange={onRole}
      />

      {visible.length === 0 && (
        <EmptyState
          title="No templates match those filters"
          description="Try a different name, tag, category, or role."
          action={filtering ? <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
        />
      )}

      <StaggerReveal className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {pageItems.map((template) => (
          <StaggerItem key={template.id}>
            <FlowTemplateCard
              template={template}
              accent={accentFor(template.category)}
              onUse={useTemplate}
              usePending={pendingId === template.id}
              useDisabled={pendingId !== null && pendingId !== template.id}
              onDelete={(t) => setDeleteTarget(t)}
            />
          </StaggerItem>
        ))}
      </StaggerReveal>
      <Pagination page={current} pageCount={pageCount} onPageChange={setPage} />

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove this template?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.name}” will be removed from the flow library. Flows already created from it are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} loading={deleting}>Remove template</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
