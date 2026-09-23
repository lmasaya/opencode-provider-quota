import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Provider = 'openai' | 'github-copilot' | 'anthropic'
export type Status = 'ok' | 'unavailable' | 'unsupported' | 'error'

export type QuotaWindow = {
  label: string
  remaining: number
  resetAt?: string
}

export type Snapshot = {
  provider: Provider
  label: string
  status: Status
  freshness: 'live' | 'cached'
  checkedAt: number
  windows: QuotaWindow[]
  facts?: string[]
  note?: string
}

type OAuth = { type: 'oauth'; access?: string; expires?: number; accountId?: string }
type AuthMap = Partial<Record<Provider, OAuth>>

const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024
const POLL_INTERVAL_MS = 60_000
const ENDPOINTS: Record<Provider, URL> = {
  openai: new URL('https://chatgpt.com/backend-api/wham/usage'),
  'github-copilot': new URL('https://api.github.com/copilot_internal/user'),
  anthropic: new URL('https://api.anthropic.com/api/oauth/usage'),
}
const OPENAI_RESET_CREDITS_ENDPOINT = new URL('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits')

const cache = new Map<Provider, { snapshot: Snapshot; promise?: Promise<Snapshot> }>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Providers report these fields on a 0-100 scale. Never rescale: a value of 1
// means one percent remaining, and guessing it was a fraction would render a
// nearly exhausted quota as full.
function percentage(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, value))
}

function ratioPercentage(value: number): number | undefined {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value * 100)) : undefined
}

function numeric(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

function date(value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    // OpenAI reports epoch seconds; Date expects milliseconds.
    const parsed = new Date(value < 1e11 ? value * 1000 : value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
  }
  if (typeof value !== 'string') return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function relativeReset(seconds: unknown): string | undefined {
  const value = numeric(seconds)
  return value === undefined || value < 0 ? undefined : new Date(Date.now() + value * 1000).toISOString()
}

function authPath() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'auth.json')
}

async function loadAuth(provider: Provider): Promise<OAuth | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath(), 'utf8'))
    if (!isRecord(parsed) || !isRecord(parsed[provider])) return undefined
    const auth = parsed[provider]
    return auth.type === 'oauth' ? auth as OAuth : undefined
  } catch {
    return undefined
  }
}

async function json(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('response too large')
  const text = await response.text()
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('response too large')
  return JSON.parse(text) as unknown
}

async function request(provider: Provider, auth: OAuth, endpoint = ENDPOINTS[provider]): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (provider === 'github-copilot') {
      headers.Authorization = `token ${auth.access}`
      headers['User-Agent'] = 'GitHubCopilotChat/0.35.0'
      headers['Editor-Version'] = 'vscode/1.107.0'
      headers['Editor-Plugin-Version'] = 'copilot-chat/0.35.0'
      headers['Copilot-Integration-Id'] = 'vscode-chat'
    } else {
      headers.Authorization = `Bearer ${auth.access}`
    }
    if (provider === 'openai' && auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId
    if (provider === 'anthropic') headers['anthropic-beta'] = 'oauth-2025-04-20'

    const response = await fetch(endpoint, { headers, redirect: 'error', signal: controller.signal })
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'authentication failed' : `upstream http ${response.status}`)
    return await json(response)
  } finally {
    clearTimeout(timer)
  }
}

// Business/enterprise plans report a credit budget under spend_control instead
// of the consumer 5h/weekly rate-limit windows.
function openaiSpendControl(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const control = payload.spend_control
  if (!isRecord(control) || !isRecord(control.individual_limit)) return undefined
  return control.individual_limit
}

function openai(payload: unknown): QuotaWindow[] {
  if (!isRecord(payload)) return []
  const limits = isRecord(payload.rate_limit) ? payload.rate_limit : {}
  const windows = [
    ['primary_window', '5h'],
    ['secondary_window', 'Weekly'],
  ].flatMap(([key, label]) => {
    const window = limits[key]
    if (!isRecord(window)) return []
    const used = percentage(window.used_percent)
    const remaining = percentage(window.remaining_percent) ?? (used === undefined ? undefined : 100 - used)
    if (remaining === undefined) return []
    return [{ label, remaining, resetAt: date(window.reset_at) ?? relativeReset(window.reset_after_seconds) }]
  })

  const limit = openaiSpendControl(payload)
  if (limit) {
    const used = percentage(limit.used_percent)
    const remaining = percentage(limit.remaining_percent) ?? (used === undefined ? undefined : 100 - used)
    if (remaining !== undefined) {
      windows.push({ label: 'Credits', remaining, resetAt: date(limit.reset_at) ?? relativeReset(limit.reset_after_seconds) })
    }
  }
  return windows
}

export function openaiFacts(payload: unknown): string[] {
  if (!isRecord(payload)) return []
  const limit = openaiSpendControl(payload)
  const remaining = numeric(limit?.remaining)
  const total = numeric(limit?.limit)
  if (remaining === undefined || total === undefined) return []
  const unit = typeof limit?.unit === 'string' && limit.unit ? `${limit.unit}s` : 'credits'
  return [`${Math.round(remaining).toLocaleString('en-US')} of ${Math.round(total).toLocaleString('en-US')} ${unit} left`]
}

function copilot(payload: unknown): QuotaWindow[] {
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots) || !isRecord(payload.quota_snapshots.premium_interactions)) return []
  const premium = payload.quota_snapshots.premium_interactions
  const byPercent = percentage(premium.percent_remaining)
  const entitlement = numeric(premium.entitlement)
  const rawRemaining = numeric(premium.remaining)
  const remaining = byPercent ?? (entitlement && rawRemaining !== undefined ? ratioPercentage(rawRemaining / entitlement) : undefined)
  if (remaining === undefined) return []
  return [{ label: 'Premium', remaining, resetAt: date(payload.quota_reset_date) || date(premium.quota_reset_date_utc) }]
}

function anthropic(payload: unknown): QuotaWindow[] {
  if (!isRecord(payload)) return []
  return [
    ['five_hour', '5h'],
    ['seven_day', 'Weekly'],
    ['seven_day_sonnet', 'Sonnet 7d'],
    ['seven_day_opus', 'Opus 7d'],
  ].flatMap(([key, label]) => {
    const window = payload[key]
    if (!isRecord(window)) return []
    const used = percentage(window.utilization)
    return used === undefined ? [] : [{ label, remaining: 100 - used, resetAt: date(window.resets_at) }]
  })
}

export function parseQuota(provider: Provider, payload: unknown): QuotaWindow[] {
  if (provider === 'openai') return openai(payload)
  if (provider === 'github-copilot') return copilot(payload)
  return anthropic(payload)
}

function noOpenAIQuota(payload: unknown): boolean {
  return isRecord(payload) && payload.rate_limit === null && payload.additional_rate_limits === null
}

export function resetCreditFact(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.available_count !== 'number' || !Number.isFinite(payload.available_count)) return undefined
  return `Reset credits: ${Math.max(0, Math.floor(payload.available_count))} available`
}

function errorNote(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || /aborted|abort/i.test(error.message))) return 'request interrupted; retrying'
  return error instanceof Error ? error.message : 'quota request failed'
}

// Drops cached snapshots so the next call re-queries every provider.
export function invalidateQuotaCache(): void {
  cache.clear()
}

export async function quota(provider: Provider, anthropicEnabled: boolean): Promise<Snapshot> {
  const label = provider === 'github-copilot' ? 'Copilot' : provider === 'anthropic' ? 'Claude' : 'OpenAI'
  if (provider === 'anthropic' && !anthropicEnabled) return { provider, label, status: 'unsupported', freshness: 'live', checkedAt: Date.now(), windows: [], note: 'disabled: unofficial endpoint' }

  const previous = cache.get(provider)
  if (previous && Date.now() - previous.snapshot.checkedAt < POLL_INTERVAL_MS) return previous.promise || { ...previous.snapshot, freshness: 'cached' }
  if (previous?.promise) return previous.promise

  const promise = (async (): Promise<Snapshot> => {
    const auth = await loadAuth(provider)
    if (!auth?.access) return { provider, label, status: 'unavailable', freshness: 'live', checkedAt: Date.now(), windows: [], note: 'OAuth authentication unavailable' }
    if (auth.expires && auth.expires <= Date.now()) return { provider, label, status: 'unavailable', freshness: 'live', checkedAt: Date.now(), windows: [], note: 'OAuth authentication expired' }
    try {
      const payload = await request(provider, auth)
      const windows = parseQuota(provider, payload)
      const facts = provider === 'openai' ? openaiFacts(payload) : []
      return windows.length > 0
        ? { provider, label, status: 'ok', freshness: 'live', checkedAt: Date.now(), windows, facts: facts.length > 0 ? facts : undefined }
        : provider === 'openai' && noOpenAIQuota(payload)
          ? {
              provider,
              label,
              status: 'ok',
              freshness: 'live',
              checkedAt: Date.now(),
              windows: [],
              facts: [resetCreditFact(await request(provider, auth, OPENAI_RESET_CREDITS_ENDPOINT).catch(() => undefined))].filter((fact): fact is string => Boolean(fact)),
              note: 'no active metered quota reported',
            }
        : { provider, label, status: 'error', freshness: 'live', checkedAt: Date.now(), windows: [], note: 'quota response changed' }
    } catch (error) {
      return { provider, label, status: 'error', freshness: 'live', checkedAt: Date.now(), windows: [], note: errorNote(error) }
    }
  })()

  cache.set(provider, { snapshot: previous?.snapshot || { provider, label, status: 'unavailable', freshness: 'live', checkedAt: 0, windows: [] }, promise })
  const snapshot = await promise
  if (snapshot.status === 'ok' || snapshot.status === 'unsupported') cache.set(provider, { snapshot })
  else cache.delete(provider)
  return snapshot
}

export function formatReset(resetAt?: string): string {
  if (!resetAt) return 'reset unknown'
  const minutes = Math.round((new Date(resetAt).getTime() - Date.now()) / 60_000)
  if (minutes <= 0) return 'reset due'
  if (minutes < 60) return `resets in ${minutes}m`
  if (minutes < 24 * 60) return `resets in ${Math.round(minutes / 60)}h`
  return `resets ${new Date(resetAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
}
