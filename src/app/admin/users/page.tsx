'use client'

/**
 * Operator user console: who is on the platform, what they are spending, and
 * the four actions an operator can take on an account.
 *
 * A table plus a detail panel rather than a card grid — this is a scanning
 * surface first ("who burned the tokens", "who has not signed in"), and the
 * actions are deliberately one click further away than the numbers.
 *
 * Every read here is audited server-side, and the page is only reachable with
 * platform.administer. The client checks nothing: /api/admin/users re-checks the
 * permission, so a hand-typed URL gains an empty table, not data.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Search, ShieldOff, ShieldCheck, KeyRound, RotateCcw, Gauge } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type PlatformUser = {
  id: string
  email: string | null
  name: string | null
  imageUrl: string | null
  timezone: string
  role: string
  platformRole: string | null
  isActive: boolean
  createdAt: string
  lastSeenAt: string | null
  runAllowanceResetAt: string | null
  organizationId: string | null
  organizationName: string | null
  organizationKind: string | null
  agentRuns: number
  flowRuns: number
  tokens: number
  costUsd: number
  integrations: number
  countableIntegrations: number
}

type Report = { days: number; truncated: boolean; users: PlatformUser[] }

type Action = 'deactivate' | 'reactivate' | 'reset-password' | 'reset-monthly-tokens' | 'reset-daily-runs'

const usd = (value: number) => (value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : '<$0.01')

/** Compact absolute date — an operator comparing accounts wants a date, not "3 days ago". */
function when(value: string | null): string {
  if (!value) return 'Never'
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

export default function PlatformUsersPage() {
  const [report, setReport] = useState<Report | null>(null)
  const [days, setDays] = useState(30)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Action | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ days: String(days) })
      if (search) params.set('q', search)
      const response = await fetch(`/api/admin/users?${params}`, { cache: 'no-store' })
      if (!response.ok) {
        toast.error('Could not load users.')
        return
      }
      setReport(await response.json())
    } finally {
      setLoading(false)
    }
  }, [days, search])

  useEffect(() => { void load() }, [load])

  const selected = useMemo(
    () => report?.users.find((user) => user.id === selectedId) ?? null,
    [report, selectedId],
  )

  const act = async (user: PlatformUser, action: Action) => {
    setBusy(action)
    try {
      const response = await fetch(`/api/admin/users/${user.id}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(body?.error ?? 'That did not work.')
        return
      }
      const label = user.email ?? user.name ?? 'the account'
      toast.success(
        action === 'deactivate' ? `Deactivated ${label}.`
        : action === 'reactivate' ? `Reactivated ${label}.`
        : action === 'reset-password' ? `Password reset email sent to ${label}.`
        : action === 'reset-monthly-tokens' ? `Monthly token counter cleared for ${user.organizationName ?? 'the workspace'}.`
        : `${label} has a fresh set of runs for today.`,
      )
      await load()
    } finally {
      setBusy(null)
    }
  }

  const totals = useMemo(() => {
    const users = report?.users ?? []
    return {
      people: users.length,
      active: users.filter((user) => user.isActive).length,
      tokens: users.reduce((sum, user) => sum + user.tokens, 0),
      cost: users.reduce((sum, user) => sum + user.costUsd, 0),
    }
  }, [report])

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Every account on the platform, across every workspace. Activity and spend are for the selected
            window; personal details and integration counts are current. Each view is recorded in the audit log.
          </p>
        </div>
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="rounded-md border px-3 py-2 text-sm"
          aria-label="Time window"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </header>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="People" value={totals.people.toLocaleString()} />
        <Stat label="Active" value={`${totals.active.toLocaleString()} of ${totals.people.toLocaleString()}`} />
        <Stat label="Tokens" value={tokenLabel(totals.tokens)} />
        <Stat label="Cost" value={usd(totals.cost)} />
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()) }}
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name or email"
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="secondary">Search</Button>
        {search && (
          <Button type="button" variant="ghost" onClick={() => { setQuery(''); setSearch('') }}>
            Clear
          </Button>
        )}
      </form>

      {report?.truncated && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
          Showing the 200 most recently active accounts. Search to narrow it down — the rest are not on this page.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Person</th>
              <th className="px-4 py-2 font-medium">Workspace</th>
              <th className="px-4 py-2 font-medium">Last seen</th>
              <th className="px-4 py-2 font-medium">Integrations</th>
              <th className="px-4 py-2 font-medium">Runs</th>
              <th className="px-4 py-2 font-medium">Tokens</th>
              <th className="px-4 py-2 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {report?.users.map((user) => (
              <tr
                key={user.id}
                onClick={() => setSelectedId(user.id === selectedId ? null : user.id)}
                className={cn(
                  'cursor-pointer transition-colors hover:bg-accent/50',
                  user.id === selectedId && 'bg-accent/60',
                  !user.isActive && 'opacity-60',
                )}
              >
                <td className="px-4 py-2.5">
                  <div className="font-medium">{user.name ?? user.email ?? 'Unnamed'}</div>
                  <div className="text-xs text-muted-foreground">{user.email ?? 'no email'}</div>
                </td>
                <td className="px-4 py-2.5">
                  <div className="truncate">{user.organizationName ?? '—'}</div>
                  <div className="text-xs text-muted-foreground">
                    {user.role.toLowerCase()}
                    {user.platformRole ? ` · ${user.platformRole}` : ''}
                    {!user.isActive ? ' · deactivated' : ''}
                  </div>
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">{when(user.lastSeenAt)}</td>
                <td className="px-4 py-2.5 tabular-nums">{user.integrations}</td>
                <td className="px-4 py-2.5 tabular-nums">{user.agentRuns + user.flowRuns}</td>
                <td className="px-4 py-2.5 tabular-nums">{tokenLabel(user.tokens)}</td>
                <td className="px-4 py-2.5 tabular-nums">{usd(user.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && report?.users.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            {search ? 'Nobody matches that search.' : 'No accounts yet.'}
          </p>
        )}
        {loading && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</p>}
      </div>

      {selected && (
        <section className="space-y-4 rounded-lg border p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{selected.name ?? selected.email ?? 'Unnamed'}</h2>
              <p className="text-sm text-muted-foreground">{selected.email ?? 'no email on file'}</p>
            </div>
            <Badge variant={selected.isActive ? 'secondary' : 'destructive'}>
              {selected.isActive ? 'Active' : 'Deactivated'}
            </Badge>
          </div>

          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Detail label="Workspace" value={`${selected.organizationName ?? '—'}${selected.organizationKind ? ` (${selected.organizationKind})` : ''}`} />
            <Detail label="Workspace role" value={selected.role.toLowerCase()} />
            <Detail label="Platform tier" value={selected.platformRole ?? 'none'} />
            <Detail label="Time zone" value={selected.timezone} />
            <Detail label="Account created" value={when(selected.createdAt)} />
            <Detail label="Last seen" value={when(selected.lastSeenAt)} />
            <Detail
              label="Integrations"
              value={`${selected.integrations} connected · ${selected.countableIntegrations} count toward the limit`}
            />
            <Detail label={`Runs (${report?.days ?? 30}d)`} value={`${selected.agentRuns} agent · ${selected.flowRuns} flow`} />
            <Detail label={`Tokens (${report?.days ?? 30}d)`} value={`${selected.tokens.toLocaleString()} · ${usd(selected.costUsd)}`} />
          </dl>

          {selected.runAllowanceResetAt && (
            <p className="text-xs text-muted-foreground">
              Daily run allowance was last reset {new Date(selected.runAllowanceResetAt).toLocaleString()}.
            </p>
          )}

          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              variant="secondary"
              disabled={busy !== null || !selected.email}
              onClick={() => void act(selected, 'reset-password')}
            >
              <KeyRound className="mr-2 h-4 w-4" />
              Send password reset
            </Button>
            <Button
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void act(selected, 'reset-daily-runs')}
            >
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset today&apos;s runs
            </Button>
            <Button
              variant="secondary"
              disabled={busy !== null || !selected.organizationId}
              onClick={() => void act(selected, 'reset-monthly-tokens')}
            >
              <Gauge className="mr-2 h-4 w-4" />
              Reset monthly tokens
            </Button>
            {selected.isActive ? (
              <Button
                variant="destructive"
                disabled={busy !== null}
                onClick={() => {
                  if (!confirm(`Deactivate ${selected.email ?? 'this account'}? They will be signed out and unable to sign back in.`)) return
                  void act(selected, 'deactivate')
                }}
              >
                <ShieldOff className="mr-2 h-4 w-4" />
                Deactivate
              </Button>
            ) : (
              <Button disabled={busy !== null} onClick={() => void act(selected, 'reactivate')}>
                <ShieldCheck className="mr-2 h-4 w-4" />
                Reactivate
              </Button>
            )}
          </div>

          {/* Said plainly, because the button name cannot carry it: the monthly
              token counter is per WORKSPACE, so resetting it from a person's
              panel lifts the ceiling for all their colleagues too. */}
          <p className="text-xs text-muted-foreground">
            Resetting monthly tokens clears the counter for the whole {selected.organizationName ?? 'workspace'},
            not just this person. Resetting today&apos;s runs affects only this account.
          </p>
        </section>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  )
}
