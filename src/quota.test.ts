import assert from 'node:assert/strict'
import test from 'node:test'
import { formatReset, parseQuota, resetCreditFact } from './quota.js'

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
      secondary_window: { remaining_percent: 0.5 },
    },
  })
  assert.deepEqual(windows.map((window) => [window.label, window.remaining]), [['5h', 80], ['Weekly', 50]])
})

test('normalizes a Copilot premium allowance', () => {
  const windows = parseQuota('github-copilot', {
    quota_reset_date: '2026-10-01T00:00:00Z',
    quota_snapshots: { premium_interactions: { remaining: 73, entitlement: 100 } },
  })
  assert.deepEqual(windows, [{ label: 'Premium', remaining: 73, resetAt: '2026-10-01T00:00:00.000Z' }])
})

test('normalizes Claude subscription windows', () => {
  const windows = parseQuota('anthropic', {
    five_hour: { utilization: 0.25 },
    seven_day: { utilization: 55 },
  })
  assert.deepEqual(windows.map((window) => [window.label, window.remaining]), [['5h', 75], ['Weekly', 45]])
})

test('does not invent an OpenAI quota when the provider reports no rate-limit windows', () => {
  assert.deepEqual(parseQuota('openai', { rate_limit: null, additional_rate_limits: null }), [])
})

test('renders an actionable OpenAI reset-credit count without treating it as a percentage', () => {
  assert.equal(resetCreditFact({ available_count: 3 }), 'Reset credits: 3 available')
  assert.equal(resetCreditFact({ available_count: '3' }), undefined)
})
