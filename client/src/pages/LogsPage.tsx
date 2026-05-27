import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`
  }
  return val
}

function formatTimeIso(iso: string): string {
  const d = new Date(iso)
  return d.toISOString()
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${
      status === 'success'
        ? 'bg-green-500/10 text-green-600 dark:text-green-400'
        : 'bg-red-500/10 text-red-600 dark:text-red-400'
    }`}>
      {status}
    </span>
  )
}

export default function LogsPage() {
  const [range, setRange] = useState<'24h' | '7d' | '30d' | 'all'>('7d')
  const [statusFilter, setStatusFilter] = useState('')
  const [platformFilter, setPlatformFilter] = useState('')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const queryKey = ['analytics', 'requests', range, statusFilter, platformFilter, page]
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () => apiFetch<any>(
      `/api/analytics/requests?range=${range}&status=${statusFilter}&platform=${platformFilter}&page=${page}&perPage=50`
    ),
  })

  const requests = data?.requests ?? []
  const totalPages = data?.totalPages ?? 0
  const platforms: string[] = data?.platforms ?? []

  function applyFilter(updater: () => void) {
    updater()
    setPage(1)
  }

  const [exporting, setExporting] = useState(false)
  const exportCsv = useCallback(async () => {
    setExporting(true)
    try {
      const res = await apiFetch<any>(
        `/api/analytics/requests?range=${range}&status=${statusFilter}&platform=${platformFilter}&page=1&perPage=10000&export=1`
      )
      const rows = res.requests ?? []
      const header = 'Time,Platform,Model,Status,Latency (ms),In Tokens,Out Tokens,Error'
      const csv = rows.map((r: any) => [
        formatTimeIso(r.createdAt),
        r.platform,
        r.modelId,
        r.status,
        r.latencyMs,
        r.inputTokens ?? 0,
        r.outputTokens ?? 0,
        escapeCsv(r.error ?? ''),
      ].join(',')).join('\n')
      const blob = new Blob([header + '\n' + csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `freellmapi-logs-${range}-${statusFilter || 'all'}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }, [range, statusFilter, platformFilter])

  return (
    <div>
      <PageHeader
        title="Request Logs"
        description="Every request through the proxy, with filtering and pagination."
        actions={
          <div className="flex gap-1 rounded-md border p-0.5">
            {(['24h', '7d', '30d', 'all'] as const).map(r => (
              <Button
                key={r}
                variant={range === r ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => applyFilter(() => setRange(r))}
              >
                {r === 'all' ? 'All' : r}
              </Button>
            ))}
          </div>
        }
      />

      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex gap-1 rounded-md border p-0.5">
            {[['', 'All'], ['success', 'Success'], ['error', 'Error']].map(([val, label]) => (
              <Button
                key={val}
                variant={statusFilter === val ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => applyFilter(() => setStatusFilter(val))}
              >
                {label}
              </Button>
            ))}
          </div>
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={platformFilter}
            onChange={e => applyFilter(() => setPlatformFilter(e.target.value))}
          >
            <option value="">All platforms</option>
            {platforms.map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground ml-auto">
            {data ? `${data.total} request${data.total !== 1 ? 's' : ''}` : ''}
          </p>
          <Button variant="outline" size="xs" onClick={exportCsv} disabled={exporting}>
            {exporting ? 'Exporting...' : 'Export CSV'}
          </Button>
        </div>

        <div className="rounded-lg border bg-card">
          {isLoading ? (
            <p className="text-sm text-muted-foreground text-center py-8">Loading...</p>
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No requests found.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4 w-40">Time</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="w-20">Status</TableHead>
                  <TableHead className="text-right w-20">Latency</TableHead>
                  <TableHead className="text-right w-20">In</TableHead>
                  <TableHead className="text-right w-20">Out</TableHead>
                  <TableHead className="pr-4">Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r: any) => (
                  <>
                    <TableRow
                      key={r.id}
                      className={r.error ? 'cursor-pointer' : ''}
                      onClick={() => r.error && setExpandedId(expandedId === r.id ? null : r.id)}
                    >
                      <TableCell className="pl-4 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
                        {formatTime(r.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs">{r.platform}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate">{r.modelId}</TableCell>
                      <TableCell><StatusBadge status={r.status} /></TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{r.latencyMs}ms</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{r.inputTokens ?? 0}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{r.outputTokens ?? 0}</TableCell>
                      <TableCell className="pr-4 text-xs max-w-[300px]">
                        {r.error ? (
                          <span className={expandedId === r.id ? '' : 'truncate block'}>
                            {r.error}
                          </span>
                        ) : (
                          <span className="text-green-600 dark:text-green-400">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                    {r.error && expandedId === r.id && (
                      <TableRow key={`${r.id}-detail`}>
                        <TableCell colSpan={8} className="px-4 pb-3">
                          <pre className="text-xs whitespace-pre-wrap break-words bg-muted rounded p-3 max-h-48 overflow-y-auto">
                            {r.error}
                          </pre>
                        </TableCell>
                      </TableRow>
                    )}
                  </>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Page {page} of {totalPages}
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="xs"
                disabled={page <= 1}
                onClick={() => setPage(p => p - 1)}
              >
                Previous
              </Button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const start = Math.max(1, Math.min(page - 2, totalPages - 4))
                const p = start + i
                if (p > totalPages) return null
                return (
                  <Button
                    key={p}
                    variant={page === p ? 'secondary' : 'ghost'}
                    size="xs"
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </Button>
                )
              })}
              <Button
                variant="outline"
                size="xs"
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
