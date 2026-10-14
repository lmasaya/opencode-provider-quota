import assert from 'node:assert/strict'
import test from 'node:test'
import { testRender } from '@opentui/solid'
import plugin from '../dist/tui.js'

const theme = { text: { base: '#ffffff', muted: '#888888' } }

const snapshot = (provider, label, windows, extra = {}) => ({
  provider,
  label,
  status: 'ok',
  freshness: 'live',
  checkedAt: Date.now(),
  windows,
  ...extra,
})

async function mount(snapshots) {
  let claim
  const calls = { count: 0 }
  const cleanup = await plugin.setup({
    theme,
    client: {
      rpc(definition) {
        assert.equal(definition.id, 'lmasaya.opencode-provider-quota')
        return { snapshots: async () => { calls.count += 1; return { snapshots: await snapshots() } } }
      },
    },
    ui: { slot(value) { claim = value; return () => {} } },
  })
  assert.equal(claim.append, 'sidebar.content')
  return { claim, calls, cleanup }
}

test('plugin definition has a stable TUI id and registers one sidebar slot', async () => {
  assert.equal(plugin.id, 'lmasaya.opencode-provider-quota.tui')
  const { claim } = await mount(async () => [])
  assert.equal(typeof claim.render, 'function')
})

test('built sidebar renders a single-window credit budget bar', async () => {
  const { claim } = await mount(async () => [
    snapshot('openai', 'OpenAI', [{ label: 'Credits', remaining: 72, resetAt: new Date(Date.now() + 3 * 3600_000).toISOString() }]),
  ])
  const screen = await testRender(() => claim.render({ sessionID: 's1' }), { width: 60, height: 30 })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    await screen.renderOnce()
    const frame = screen.captureCharFrame()
    assert.match(frame, /QUOTA/)
    assert.match(frame, /OpenAI/)
    assert.match(frame, /72%/)
    assert.doesNotMatch(frame, /Loading quota/)
  } finally {
    screen.renderer.destroy()
  }
})

test('built sidebar renders both providers, refreshes without duplicating cards, and cleans up', async () => {
  const originalInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let refresh
  let cleared = false
  globalThis.setInterval = (callback, ms, ...args) => {
    if (ms !== 60000) return originalInterval(callback, ms, ...args)
    refresh = callback
    return 'quota-test-timer'
  }
  globalThis.clearInterval = timer => {
    if (timer === 'quota-test-timer') cleared = true
    else originalClearInterval(timer)
  }
  let release
  const gate = new Promise(resolve => { release = resolve })
  let first = true
  const { claim, calls } = await mount(async () => {
    if (first) { first = false; await gate }
    return [
      snapshot('openai', 'OpenAI', [{ label: '5h', remaining: 80 }]),
      snapshot('github-copilot', 'Copilot', [{ label: 'Premium', remaining: 77 }]),
    ]
  })
  let screen
  try {
    screen = await testRender(() => claim.render({ sessionID: 's1' }), { width: 60, height: 30 })
    await screen.renderOnce()
    assert.match(screen.captureCharFrame(), /Loading quota/)
    release()
    await new Promise(resolve => setTimeout(resolve, 50))
    await screen.renderOnce()
    let frame = screen.captureCharFrame()
    assert.match(frame, /OpenAI/)
    assert.match(frame, /80%/)
    assert.match(frame, /Copilot/)
    assert.match(frame, /77%/)
    refresh()
    await new Promise(resolve => setTimeout(resolve, 50))
    await screen.renderOnce()
    frame = screen.captureCharFrame()
    assert.equal(calls.count, 2)
    assert.equal(frame.match(/Copilot/g)?.length, 1)
    assert.equal(frame.match(/OpenAI/g)?.length, 1)
    screen.renderer.destroy()
    assert.equal(cleared, true)
    screen = undefined
  } finally {
    screen?.renderer.destroy()
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClearInterval
  }
})

test('built sidebar shows a safe error state when the quota RPC fails', async () => {
  const { claim } = await mount(async () => { throw new Error('server unavailable') })
  const screen = await testRender(() => claim.render({ sessionID: 's1' }), { width: 60, height: 30 })
  try {
    await new Promise(resolve => setTimeout(resolve, 100))
    await screen.renderOnce()
    const frame = screen.captureCharFrame()
    assert.match(frame, /quota refresh failed/)
    assert.doesNotMatch(frame, /server unavailable/)
  } finally {
    screen.renderer.destroy()
  }
})
