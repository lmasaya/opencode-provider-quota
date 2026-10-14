import { createElement, insert, setProp } from '@opentui/solid'
import { Plugin } from '@opencode/plugin/tui'
import { getOwner, onCleanup, runWithOwner } from 'solid-js'
import { formatReset, providers, type Snapshot } from './quota.js'
import { QuotaRpc } from './rpc.js'

type Context = Plugin.Context

function el(tag: string, props: Record<string, unknown> = {}, children: unknown[] = []) {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) setProp(node, key, value)
  insert(node, children)
  return node
}

function tone(context: Context, snapshot: Snapshot) {
  return snapshot.status === 'ok' ? context.theme.text.base : context.theme.text.muted
}

function providerColor() {
  return '#ffffff'
}

function bar(context: Context, snapshot: Snapshot, remaining: number) {
  const width = 16
  const percent = `${Math.round(remaining)}%`
  const filled = Math.round((remaining / 100) * width)
  const before = Math.max(0, Math.floor((width - percent.length) / 2))
  const after = width - before - percent.length
  const color = providerColor()
  const segment = (start: number, length: number) => {
    const colored = Math.max(0, Math.min(length, filled - start))
    return [
      colored > 0 ? el('span', { style: { bg: color } }, [' '.repeat(colored)]) : undefined,
      length - colored > 0 ? el('span', {}, [' '.repeat(length - colored)]) : undefined,
    ].filter(Boolean)
  }
  return ['[', ...segment(0, before), el('span', { style: { fg: '#000000', bg: color } }, [el('b', {}, [percent])]), ...segment(before + percent.length, after), ']']
}

function card(context: Context, snapshot: Snapshot) {
  const windows = snapshot.windows.slice(0, 2)
  const singleWindow = windows.length === 1
  const children: unknown[] = [el('text', { fg: tone(context, snapshot) }, [el('b', {}, [snapshot.label]), singleWindow ? [' ', ...bar(context, snapshot, windows[0].remaining)] : snapshot.status === 'ok' ? '' : `  ${snapshot.note ?? snapshot.status}`])]
  if (singleWindow) {
    children.push(el('text', { fg: context.theme.text.muted }, [formatReset(windows[0].resetAt)]))
  } else for (const window of windows) {
    children.push(el('text', { fg: tone(context, snapshot) }, [window.label.padEnd(8), ' ', ...bar(context, snapshot, window.remaining)]))
    children.push(el('text', { fg: context.theme.text.muted }, [formatReset(window.resetAt)]))
  }
  // Absolute credit/reset-credit counts (snapshot.facts) are intentionally not
  // rendered: the bar and reset time are enough context for the sidebar.
  if (snapshot.status === 'ok' && snapshot.note) children.push(el('text', { fg: context.theme.text.muted }, [snapshot.note]))
  return el('box', { flexDirection: 'column', width: '100%', gap: 0, paddingBottom: 1 }, children)
}

function failed(provider: Snapshot['provider']): Snapshot {
  return { provider, label: provider === 'github-copilot' ? 'Copilot' : 'OpenAI', status: 'error', freshness: 'live', checkedAt: Date.now(), windows: [], note: 'quota refresh failed' }
}

function sidebar(context: Context) {
  const rpc = context.client.rpc(QuotaRpc)
  const owner = getOwner()
  const cards = el('box', { flexDirection: 'column', width: '100%', gap: 0 }, [el('text', { fg: context.theme.text.muted }, ['Loading quota...'])])
  const root = el('box', { flexDirection: 'column', width: '100%', gap: 0, paddingTop: 1, paddingRight: 1 }, [el('text', { fg: context.theme.text.muted }, [el('b', {}, ['QUOTA'])]), cards])
  const snapshots = new Map<Snapshot['provider'], Snapshot>()
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const render = () => {
    if (disposed) return
    // Promise callbacks have no Solid owner. Restore the slot's renderer
    // context before creating nodes, including error-state nodes.
    runWithOwner(owner, () => {
      const rendered = providers.flatMap((provider) => {
        const snapshot = snapshots.get(provider)
        return snapshot ? [card(context, snapshot)] : []
      })
      insert(cards, null)
      insert(cards, rendered.length > 0 ? rendered : el('text', { fg: context.theme.text.muted }, ['Loading quota...']))
    })
  }
  const retrySoon = () => {
    if (retryTimer || disposed) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      refresh()
    }, 5000)
  }
  const refresh = () => {
    void rpc.snapshots({}).then((result) => {
      const list = (result as { snapshots?: Snapshot[] }).snapshots
      if (!Array.isArray(list)) throw new Error('unexpected quota response')
      for (const snapshot of list) snapshots.set(snapshot.provider, snapshot)
      render()
      if (list.some((snapshot) => snapshot.status === 'error')) retrySoon()
    }).catch(() => {
      for (const provider of providers) snapshots.set(provider, failed(provider))
      render()
      retrySoon()
    })
  }
  refresh()
  const interval = setInterval(refresh, 60_000)
  onCleanup(() => {
    disposed = true
    clearInterval(interval)
    if (retryTimer) clearTimeout(retryTimer)
  })
  return root as unknown as ReturnType<Parameters<Context['ui']['slot']>[0]['render']>
}

export default Plugin.define({
  id: 'lmasaya.opencode-provider-quota.tui',
  setup(context) {
    return context.ui.slot({ append: 'sidebar.content', render: () => sidebar(context) })
  },
})
