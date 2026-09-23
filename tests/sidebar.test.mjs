import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testRender } from '@opentui/solid'
import plugin from '../dist/tui.js'

test('built sidebar renders asynchronous quota bars, refreshes, and cleans up', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quota-ui-test-'))
  const originalDataHome = process.env.XDG_DATA_HOME
  const originalFetch = globalThis.fetch
  const originalInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  process.env.XDG_DATA_HOME = directory
  await mkdir(join(directory, 'opencode'))
  await writeFile(join(directory, 'opencode', 'auth.json'), JSON.stringify({
    openai: { type: 'oauth', access: 'test-only', expires: Date.now() + 3600000 },
    'github-copilot': { type: 'oauth', access: 'test-only' },
  }), { mode: 0o600 })
  let completeOpenAI
  globalThis.fetch = async url => {
    if (String(url) === 'https://chatgpt.com/backend-api/wham/usage') {
      return new Promise(resolve => { completeOpenAI = () => resolve(Response.json({
        rate_limit: { primary_window: { used_percent: 20, reset_after_seconds: 600 } },
      })) })
    }
    assert.equal(String(url), 'https://api.github.com/copilot_internal/user')
    return Response.json({ quota_snapshots: { premium_interactions: { percent_remaining: 77 } } })
  }
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
  let slot
  let screen
  try {
    await plugin.tui({
      theme: { current: { textMuted: '#888888', success: '#00ff00', warning: '#ffaa00', error: '#ff0000', info: '#0088ff' } },
      slots: { register(value) { slot = value.slots.sidebar_content } },
    })
    screen = await testRender(() => slot(), { width: 60, height: 30 })
    await new Promise(resolve => setTimeout(resolve, 100))
    await screen.renderOnce()
    let frame = screen.captureCharFrame()
    assert.match(frame, /Copilot/)
    assert.match(frame, /77%/)
    assert.match(frame, /Claude/)
    assert.doesNotMatch(frame, /OpenAI/)
    completeOpenAI()
    await new Promise(resolve => setTimeout(resolve, 30))
    await screen.renderOnce()
    frame = screen.captureCharFrame()
    assert.match(frame, /QUOTA/)
    assert.match(frame, /OpenAI/)
    assert.match(frame, /Copilot/)
    assert.match(frame, /Claude/)
    assert.match(frame, /80%/)
    assert.doesNotMatch(frame, /Loading quota/)
    refresh()
    await new Promise(resolve => setTimeout(resolve, 30))
    await screen.renderOnce()
    frame = screen.captureCharFrame()
    assert.equal(frame.match(/Copilot/g)?.length, 1)
    assert.equal(frame.match(/OpenAI/g)?.length, 1)
    assert.equal(frame.match(/Claude/g)?.length, 1)
    screen.renderer.destroy()
    assert.equal(cleared, true)
    screen = undefined
  } finally {
    screen?.renderer.destroy()
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClearInterval
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = originalDataHome
    await rm(directory, { recursive: true, force: true })
  }
})
