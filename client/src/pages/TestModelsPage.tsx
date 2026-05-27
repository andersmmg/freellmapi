import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'

interface ModelEntry {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  keyCount: number
  enabled: boolean
  priority: number
}

interface TestResult {
  success: boolean
  latency: number
  error?: string
}

const platformColors: Record<string, string> = {
  google:      '#4285f4',
  groq:        '#f55036',
  cerebras:    '#8b5cf6',
  sambanova:   '#14b8a6',
  nvidia:      '#76b900',
  mistral:     '#f59e0b',
  openrouter:  '#ec4899',
  github:      '#6e7b8b',
  cohere:      '#d946ef',
  cloudflare:  '#f38020',
  zhipu:       '#06b6d4',
  ollama:      '#000000',
  kilo:        '#7c3aed',
  pollinations: '#a855f7',
  llm7:        '#0ea5e9',
  huggingface: '#ff9d00',
}

function ErrorTooltip({ error }: { error: string }) {
  const [show, setShow] = useState(false)
  return (
    <span
      className="relative"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="15" y1="9" x2="9" y2="15"/>
        <line x1="9" y1="9" x2="15" y2="15"/>
      </svg>
      {show && (
        <div className="absolute z-50 bottom-full mb-2 left-1/2 -translate-x-1/2 w-72 p-2 rounded-md border bg-popover text-xs text-popover-foreground shadow-md whitespace-pre-wrap break-words">
          {error}
        </div>
      )}
    </span>
  )
}

export default function TestModelsPage() {
  const queryClient = useQueryClient()

  const { data: entries = [], isLoading } = useQuery<ModelEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback'] }),
  })

  const [results, setResults] = useState<Record<number, TestResult>>({})
  const [testing, setTesting] = useState<Set<number>>(new Set())
  const [testingAll, setTestingAll] = useState(false)

  const [showNoKey, setShowNoKey] = useState(false)
  const available = entries.filter(e => e.keyCount > 0)
  const displayed = showNoKey ? entries : available

  function handleToggle(entry: ModelEntry) {
    const updated = entries.map(e =>
      e.modelDbId === entry.modelDbId ? { ...e, enabled: !e.enabled } : e
    )
    queryClient.setQueryData(['fallback'], updated)
    saveMutation.mutate(
      updated.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled }))
    )
  }

  async function testModel(modelDbId: number) {
    setTesting(prev => new Set(prev).add(modelDbId))
    try {
      const res = await apiFetch<TestResult>('/api/analytics/test-model', {
        method: 'POST',
        body: JSON.stringify({ modelDbId }),
      })
      setResults(prev => ({ ...prev, [modelDbId]: res }))
    } catch {
      setResults(prev => ({ ...prev, [modelDbId]: { success: false, latency: 0, error: 'Request failed' } }))
    } finally {
      setTesting(prev => { const next = new Set(prev); next.delete(modelDbId); return next })
    }
  }

  async function testAll() {
    setTestingAll(true)
    setResults({})
    for (const entry of available) {
      await testModel(entry.modelDbId)
    }
    setTestingAll(false)
  }

  const successCount = Object.values(results).filter(r => r.success).length
  const testedCount = Object.keys(results).length

  return (
    <div>
      <PageHeader
        title="Model test"
        description="Test each model with a tiny request to check if it's working."
        actions={
          <Button size="sm" onClick={testAll} disabled={testingAll}>
            {testingAll ? 'Testing...' : `Test all (${available.length})`}
          </Button>
        }
      />

      {testedCount > 0 && (
        <p className="text-xs text-muted-foreground mb-4">
          {successCount}/{testedCount} models passed
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading models...</p>
      ) : displayed.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No models in the fallback chain.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {displayed.map(entry => {
            const hasKey = entry.keyCount > 0
            const result = results[entry.modelDbId]
            const running = testing.has(entry.modelDbId)
            return (
              <div
                key={entry.modelDbId}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border bg-card ${!hasKey ? 'opacity-40' : entry.enabled ? '' : 'opacity-50'}`}
              >
                <span
                  className="size-2.5 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: platformColors[entry.platform] ?? '#94a3b8' }}
                />
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-sm">{entry.displayName}</span>
                  <span className="text-xs text-muted-foreground ml-2">{entry.platform}/{entry.modelId}</span>
                  {!hasKey && <span className="text-xs text-muted-foreground ml-2 italic">no key</span>}
                </div>
                <div className="flex items-center gap-2">
                  {result && (
                    result.success ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600 dark:text-green-400">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="20 6 9 17 4 12"/>
                        </svg>
                        {result.latency}ms
                      </span>
                    ) : (
                      <ErrorTooltip error={result.error ?? 'Unknown error'} />
                    )
                  )}
                  {running ? (
                    <span className="text-xs text-muted-foreground animate-pulse">testing...</span>
                  ) : hasKey ? (
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => testModel(entry.modelDbId)}
                    >
                      Test
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                  <Switch
                    checked={entry.enabled}
                    onCheckedChange={() => handleToggle(entry)}
                    disabled={!hasKey}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
      {available.length < entries.length && (
        <button
          className="text-xs text-muted-foreground hover:text-foreground mt-2"
          onClick={() => setShowNoKey(v => !v)}
        >
          {showNoKey ? 'Hide' : 'Show'} {entries.length - available.length} models without keys
        </button>
      )}
    </div>
  )
}
