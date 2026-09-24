import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatReset, openaiFacts, parseQuota, quota, resetCreditFact } from './quota.js'

test('formats a future reset without exposing an absolute timestamp for nearby resets', () => {
  const reset = new Date(Date.now() + 30 * 60_000).toISOString()
  assert.match(formatReset(reset), /^resets in \d+m$/)
})

test('formats an absent reset safely', () => {
  assert.equal(formatReset(), 'reset unknown')
})

test('normalizes OpenAI primary and secondary windows', () => {
  const windows = parseQuota('openai', {
    rate_limit: {
      primary_window: { used_percent: 20, reset_after_seconds: 300 },
      secondary_window: { remaining_percent: 50 },
    },
  })
  assert.deepEqual(windows.map((window) => [window.label, window.remaining]), [['5h', 80], ['Weekly', 50]])
})

test('reads the business-plan credit budget when rate-limit windows are absent', () => {
  const windows = parseQuota('openai', {
    rate_limit: null,
    additional_rate_limits: null,
    spend_control: {
      reached: false,
      individual_limit: { unit: 'credit', limit: '7500', used: '2109.71', remaining: '5390.29', used_percent: 28, remaining_percent: 72, reset_at: 1790812800 },
    },
  })
  assert.deepEqual(windows, [{ label: 'Credits', remaining: 72, resetAt: '2026-10-01T00:00:00.000Z' }])
})

test('reports the absolute credit balance alongside the bar', () => {
  const facts = openaiFacts({
    spend_control: { individual_limit: { unit: 'credit', limit: '7500', remaining: '5390.29' } },
  })
  assert.deepEqual(facts, ['5,390 of 7,500 credits left'])
})

test('treats a one percent remainder as nearly exhausted rather than full', () => {
  const windows = parseQuota('openai', { rate_limit: { primary_window: { remaining_percent: 1 } } })
  assert.equal(windows[0].remaining, 1)
})

test('normalizes a Copilot premium allowance', () => {
  const windows = parseQuota('github-copilot', {
    quota_reset_date: '2026-10-01T00:00:00Z',
    quota_snapshots: { premium_interactions: { remaining: 73, entitlement: 100 } },
  })
  assert.deepEqual(windows, [{ label: 'Premium', remaining: 73, resetAt: '2026-10-01T00:00:00.000Z' }])
})

test('does not invent an OpenAI quota when the provider reports neither windows nor a credit budget', () => {
  assert.deepEqual(parseQuota('openai', { rate_limit: null, additional_rate_limits: null }), [])
  assert.deepEqual(openaiFacts({ rate_limit: null }), [])
})

test('renders an actionable OpenAI reset-credit count without treating it as a percentage', () => {
  assert.equal(resetCreditFact({ available_count: 3 }), 'Reset credits: 3 available')
  assert.equal(resetCreditFact({ available_count: '3' }), undefined)
})

test('labels an interrupted request as retryable', async () => {
  const originalFetch = globalThis.fetch
  const originalDataHome = process.env.XDG_DATA_HOME
  const directory = await mkdtemp(join(tmpdir(), 'opencode-quota-test-'))
  process.env.XDG_DATA_HOME = directory
  await mkdir(join(directory, 'opencode'))
  await writeFile(join(directory, 'opencode', 'auth.json'), JSON.stringify({ openai: { type: 'oauth', access: 'test-only', expires: Date.now() + 3600000 } }), { mode: 0o600 })
  globalThis.fetch = async () => { throw new DOMException('The operation was aborted.', 'AbortError') }
  try {
    const snapshot = await quota('openai')
    assert.equal(snapshot.note, 'request interrupted; retrying')
  } finally {
    globalThis.fetch = originalFetch
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalDataHome
    await rm(directory, { recursive: true, force: true })
  }
})
