'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Database, Download, Files, Loader2, Pencil, Plus, TableProperties, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { useAuth } from '@/hooks/use-auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/ui/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/settings/dialogs'
import { DATA_TABLE_COLUMN_TYPES, type DataTableColumn } from '@/lib/data-tables/schema'
import { cn } from '@/lib/utils'
import { ContentRepository } from '@/components/repository/content-repository'

type DataTable = {
  id: string
  name: string
  description: string
  columns: DataTableColumn[]
  version: number
  createdAt: string
  updatedAt: string
}
type DataRow = { id: string; data: Record<string, unknown>; createdAt: string; updatedAt: string }
type TableDraft = { id?: string; name: string; description: string; columns: DataTableColumn[]; version?: number }

const emptyTable = (): TableDraft => ({ name: '', description: '', columns: [{ name: 'name', type: 'string', required: false }] })
const displayValue = (value: unknown) => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)

function inputValue(value: unknown, type: DataTableColumn['type']): string {
  if (value == null) return ''
  if (type === 'object' || type === 'array' || type === 'any') return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return String(value)
}

function rowPayload(draft: Record<string, string | boolean>, columns: DataTableColumn[]): Record<string, unknown> {
  return Object.fromEntries(columns.flatMap((column) => {
    const value = draft[column.name]
    if (value === '' || value === undefined) return column.required ? [[column.name, value]] : []
    if (column.type === 'boolean') return [[column.name, Boolean(value)]]
    if (column.type === 'number') {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(`${column.label ?? column.name} must be a number.`)
      return [[column.name, number]]
    }
    if (column.type === 'object' || column.type === 'array') {
      try { return [[column.name, JSON.parse(String(value))]] }
      catch { throw new Error(`${column.label ?? column.name} must be valid JSON.`) }
    }
    if (column.type === 'any') {
      try { return [[column.name, JSON.parse(String(value))]] }
      catch { return [[column.name, value]] }
    }
    return [[column.name, value]]
  }))
}

function StructuredTables({ writable }: { writable: boolean }) {
  const [tables, setTables] = useState<DataTable[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rows, setRows] = useState<DataRow[]>([])
  const [loading, setLoading] = useState(true)
  const [rowsLoading, setRowsLoading] = useState(false)
  const [tableDraft, setTableDraft] = useState<TableDraft | null>(null)
  const [rowDraft, setRowDraft] = useState<Record<string, string | boolean> | null>(null)
  const [editingRowId, setEditingRowId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTable, setDeleteTable] = useState<DataTable | null>(null)
  const [deleteRow, setDeleteRow] = useState<DataRow | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const selected = useMemo(() => tables.find((table) => table.id === selectedId) ?? null, [tables, selectedId])

  const loadTables = useCallback(async () => {
    const response = await fetch('/api/data-tables', { cache: 'no-store' })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'Could not load data tables.')
    const next = (data.tables ?? []) as DataTable[]
    setTables(next)
    setSelectedId((current) => current && next.some((table) => table.id === current) ? current : next[0]?.id ?? null)
  }, [])

  const loadRows = useCallback(async (id: string) => {
    setRowsLoading(true)
    try {
      const response = await fetch(`/api/data-tables/${id}/rows?limit=500`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not load table rows.')
      setRows(data.rows ?? [])
    } finally {
      setRowsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTables().catch((error) => toast.error(error.message)).finally(() => setLoading(false))
  }, [loadTables])
  useEffect(() => {
    if (!selectedId) { setRows([]); return }
    loadRows(selectedId).catch((error) => toast.error(error.message))
  }, [loadRows, selectedId])

  const saveTable = async () => {
    if (!tableDraft) return
    setSaving(true)
    try {
      const method = tableDraft.id ? 'PATCH' : 'POST'
      const response = await fetch('/api/data-tables', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tableDraft.id ? {
          id: tableDraft.id,
          name: tableDraft.name,
          description: tableDraft.description,
          columns: tableDraft.columns,
          expectedVersion: tableDraft.version,
        } : tableDraft),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save data table.')
      await loadTables()
      setSelectedId(data.table.id)
      setTableDraft(null)
      toast.success(tableDraft.id ? 'Data table updated.' : 'Data table created.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const saveRow = async () => {
    if (!selected || !rowDraft) return
    setSaving(true)
    try {
      const payload = rowPayload(rowDraft, selected.columns)
      const response = await fetch(`/api/data-tables/${selected.id}/rows`, {
        method: editingRowId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(editingRowId ? { rowId: editingRowId, data: payload } : { data: payload }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not save row.')
      await loadRows(selected.id)
      setRowDraft(null)
      setEditingRowId(null)
      toast.success(editingRowId ? 'Row updated.' : 'Row added.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const importCsv = async (file?: File) => {
    if (!selected || !file) return
    setSaving(true)
    try {
      const response = await fetch(`/api/data-tables/${selected.id}/csv`, {
        method: 'POST',
        headers: { 'content-type': 'text/csv; charset=utf-8' },
        body: await file.text(),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || 'Could not import CSV.')
      await loadRows(selected.id)
      toast.success(`Imported ${data.imported} row${data.imported === 1 ? '' : 's'}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (loading) return <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div><h2 className="text-lg font-semibold">Structured tables</h2><p className="mt-1 text-sm text-muted-foreground">Typed reference data, queues, checkpoints, and cross-run workflow state.</p></div>
        {writable && <Button onClick={() => setTableDraft(emptyTable())}><Plus className="mr-1.5 h-4 w-4" />New table</Button>}
      </div>

      {tables.length === 0 ? (
        <EmptyState icon={Database} title="No data tables yet" description="Create a table for reference data, queues, checkpoints, or cross-run workflow state." action={writable ? <Button onClick={() => setTableDraft(emptyTable())}>Create data table</Button> : undefined} />
      ) : (
        <div className="grid min-h-[32rem] gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <Card className="h-fit">
            <CardHeader><CardTitle>Tables</CardTitle><CardDescription>{tables.length} in this workspace</CardDescription></CardHeader>
            <CardContent className="space-y-1">
              {tables.map((table) => (
                <button key={table.id} type="button" onClick={() => setSelectedId(table.id)} className={cn('w-full rounded-lg px-3 py-2 text-left transition-colors', selectedId === table.id ? 'bg-horizon-50 text-horizon-800' : 'hover:bg-muted')}>
                  <span className="block truncate text-sm font-medium">{table.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{table.description || `${table.columns.length} columns`}</span>
                </button>
              ))}
            </CardContent>
          </Card>

          {selected && (
            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><h2 className="text-lg font-semibold">{selected.name}</h2><p className="text-sm text-muted-foreground">{selected.description || `${selected.columns.length} typed columns`}</p></div>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline"><a href={`/api/data-tables/${selected.id}/csv`}><Download className="mr-1.5 h-4 w-4" />Export CSV</a></Button>
                  {writable && <>
                    <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => void importCsv(event.target.files?.[0])} />
                    <Button variant="outline" disabled={saving} onClick={() => fileRef.current?.click()}><Upload className="mr-1.5 h-4 w-4" />Import CSV</Button>
                    <Button variant="outline" onClick={() => setTableDraft({ ...selected, columns: selected.columns.map((column) => ({ ...column })) })}><Pencil className="mr-1.5 h-4 w-4" />Schema</Button>
                    <Button onClick={() => { setEditingRowId(null); setRowDraft({}) }}><Plus className="mr-1.5 h-4 w-4" />Add row</Button>
                  </>}
                </div>
              </div>
              {rowsLoading ? <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div> : rows.length === 0 ? (
                <Card><CardContent className="py-14 text-center text-sm text-muted-foreground">This table has no rows yet.</CardContent></Card>
              ) : (
                <Table stickyHeader>
                  <TableHeader><TableRow>{selected.columns.map((column) => <TableHead key={column.name}>{column.label ?? column.name}</TableHead>)}{writable && <TableHead className="w-24">Actions</TableHead>}</TableRow></TableHeader>
                  <TableBody>{rows.map((row) => <TableRow key={row.id}>{selected.columns.map((column) => <TableCell key={column.name} className="max-w-64 truncate font-mono text-xs" title={displayValue(row.data[column.name])}>{displayValue(row.data[column.name])}</TableCell>)}{writable && <TableCell><div className="flex gap-1"><Button size="icon" variant="ghost" aria-label="Edit row" onClick={() => { setEditingRowId(row.id); setRowDraft(Object.fromEntries(selected.columns.map((column) => [column.name, column.type === 'boolean' ? Boolean(row.data[column.name]) : inputValue(row.data[column.name], column.type)]))) }}><Pencil className="h-3.5 w-3.5" /></Button><Button size="icon" variant="ghost" aria-label="Delete row" onClick={() => setDeleteRow(row)}><Trash2 className="h-3.5 w-3.5 text-red-600" /></Button></div></TableCell>}</TableRow>)}</TableBody>
                </Table>
              )}
              {writable && <Button variant="ghost" className="text-red-600" onClick={() => setDeleteTable(selected)}><Trash2 className="mr-1.5 h-4 w-4" />Delete table</Button>}
            </div>
          )}
        </div>
      )}

      <Dialog open={Boolean(tableDraft)} onOpenChange={(open) => { if (!open && !saving) setTableDraft(null) }}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>{tableDraft?.id ? 'Edit data table' : 'Create data table'}</DialogTitle><DialogDescription>Define stable typed columns. Existing rows must remain compatible with schema edits.</DialogDescription></DialogHeader>
          {tableDraft && <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>Name</Label><Input value={tableDraft.name} onChange={(event) => setTableDraft({ ...tableDraft, name: event.target.value })} /></div><div className="space-y-1.5"><Label>Description</Label><Input value={tableDraft.description} onChange={(event) => setTableDraft({ ...tableDraft, description: event.target.value })} /></div></div>
            <div className="space-y-2"><div className="flex items-center justify-between"><Label>Columns</Label><Button size="sm" variant="outline" onClick={() => setTableDraft({ ...tableDraft, columns: [...tableDraft.columns, { name: '', type: 'string', required: false }] })}><Plus className="mr-1 h-3.5 w-3.5" />Column</Button></div>
              {tableDraft.columns.map((column, index) => <div key={index} className="grid items-center gap-2 rounded-lg border p-2 sm:grid-cols-[1fr_9rem_auto_auto]">
                <Input aria-label={`Column ${index + 1} name`} placeholder="column_name" value={column.name} onChange={(event) => setTableDraft({ ...tableDraft, columns: tableDraft.columns.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item) })} />
                <select className="h-10 rounded-md border bg-background px-2 text-sm" value={column.type} onChange={(event) => setTableDraft({ ...tableDraft, columns: tableDraft.columns.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value as DataTableColumn['type'] } : item) })}>{DATA_TABLE_COLUMN_TYPES.map((type) => <option key={type}>{type}</option>)}</select>
                <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={column.required} onChange={(event) => setTableDraft({ ...tableDraft, columns: tableDraft.columns.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item) })} />Required</label>
                <Button size="icon" variant="ghost" aria-label={`Remove ${column.name || 'column'}`} onClick={() => setTableDraft({ ...tableDraft, columns: tableDraft.columns.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 className="h-4 w-4" /></Button>
              </div>)}
            </div>
          </div>}
          <DialogFooter><Button variant="outline" onClick={() => setTableDraft(null)} disabled={saving}>Cancel</Button><Button onClick={() => void saveTable()} disabled={saving || !tableDraft?.name.trim() || tableDraft.columns.some((column) => !column.name.trim())}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save table</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(rowDraft)} onOpenChange={(open) => { if (!open && !saving) { setRowDraft(null); setEditingRowId(null) } }}>
        <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto"><DialogHeader><DialogTitle>{editingRowId ? 'Edit row' : 'Add row'}</DialogTitle><DialogDescription>Values are validated against {selected?.name}&apos;s current schema.</DialogDescription></DialogHeader>
          {selected && rowDraft && <div className="grid gap-4 sm:grid-cols-2">{selected.columns.map((column) => <div key={column.name} className={cn('space-y-1.5', (column.type === 'object' || column.type === 'array' || column.type === 'any') && 'sm:col-span-2')}><Label>{column.label ?? column.name}{column.required && ' *'}</Label>{column.type === 'boolean' ? <label className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm"><input type="checkbox" checked={Boolean(rowDraft[column.name])} onChange={(event) => setRowDraft({ ...rowDraft, [column.name]: event.target.checked })} />True</label> : column.type === 'object' || column.type === 'array' || column.type === 'any' ? <Textarea value={String(rowDraft[column.name] ?? '')} onChange={(event) => setRowDraft({ ...rowDraft, [column.name]: event.target.value })} placeholder={column.type === 'array' ? '[]' : '{}'} /> : <Input type={column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : column.type === 'dateTime' ? 'datetime-local' : 'text'} value={String(rowDraft[column.name] ?? '')} onChange={(event) => setRowDraft({ ...rowDraft, [column.name]: event.target.value })} />}</div>)}</div>}
          <DialogFooter><Button variant="outline" onClick={() => setRowDraft(null)} disabled={saving}>Cancel</Button><Button onClick={() => void saveRow()} disabled={saving}>{saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Save row</Button></DialogFooter></DialogContent>
      </Dialog>

      <ConfirmDialog open={Boolean(deleteTable)} onOpenChange={(open) => { if (!open) setDeleteTable(null) }} title="Delete data table?" description="This permanently deletes the table and every row. Flows and agents using it will fail until reconfigured." confirmLabel="Delete table" destructive requireText={deleteTable?.name} busy={saving} onConfirm={async () => { if (!deleteTable) return; setSaving(true); try { const response = await fetch('/api/data-tables', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: deleteTable.id, confirmation: deleteTable.name }) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not delete table.'); setDeleteTable(null); await loadTables(); toast.success('Data table deleted.') } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) } }} />
      <ConfirmDialog open={Boolean(deleteRow)} onOpenChange={(open) => { if (!open) setDeleteRow(null) }} title="Delete row?" description="This row will be removed immediately." confirmLabel="Delete row" destructive busy={saving} onConfirm={async () => { if (!selected || !deleteRow) return; setSaving(true); try { const response = await fetch(`/api/data-tables/${selected.id}/rows`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rowId: deleteRow.id }) }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || 'Could not delete row.'); setDeleteRow(null); await loadRows(selected.id); toast.success('Row deleted.') } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) } finally { setSaving(false) } }} />
    </div>
  )
}

export default function DataTablesPage() {
  const { can } = useAuth()
  const writable = can('flow.write')
  const [view, setView] = useState<'files' | 'tables'>('files')

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workspace knowledge"
        title="Content Repository"
        description="Upload files, pull content from connected sources, and control exactly what agents can retrieve."
      />
      <div className="inline-flex rounded-lg border bg-muted/40 p-1" role="tablist" aria-label="Repository views">
        <button type="button" role="tab" aria-selected={view === 'files'} onClick={() => setView('files')} className={cn('inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors', view === 'files' ? 'bg-background text-foreground shadow-1' : 'text-muted-foreground hover:text-foreground')}><Files className="h-4 w-4" />Files</button>
        <button type="button" role="tab" aria-selected={view === 'tables'} onClick={() => setView('tables')} className={cn('inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors', view === 'tables' ? 'bg-background text-foreground shadow-1' : 'text-muted-foreground hover:text-foreground')}><TableProperties className="h-4 w-4" />Structured tables</button>
      </div>
      {view === 'files' ? <ContentRepository writable={writable} /> : <StructuredTables writable={writable} />}
    </div>
  )
}
