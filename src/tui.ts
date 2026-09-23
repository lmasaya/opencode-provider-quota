import { createElement, insert, setProp } from '@opentui/solid'
import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { getOwner, onCleanup, runWithOwner } from 'solid-js'
import { formatReset, quota, type Snapshot } from './quota.js'

const providers = ['openai', 'github-copilot', 'anthropic'] as const
const anthropicEnabled = process.env.OPENCODE_QUOTA_ENABLE_ANTHROPIC === '1'

function el(tag: string, props: Record<string, unknown> = {}, children: unknown[] = []) {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) setProp(node, key, value)
  insert(node, children)
  return node
}

function tone(api: Parameters<TuiPlugin>[0], snapshot: Snapshot) {
  return snapshot.status === 'ok' ? api.theme.current.text : api.theme.current.textMuted
}

function providerColor() {
  return '#ffffff'
}

function bar(api: Parameters<TuiPlugin>[0], snapshot: Snapshot, remaining: number) {
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

function card(api: Parameters<TuiPlugin>[0], snapshot: Snapshot) {
  const windows = snapshot.windows.slice(0, 2)
  const singleWindow = windows.length === 1
  const children: unknown[] = [el('text', { fg: tone(api, snapshot) }, [el('b', {}, [snapshot.label]), singleWindow ? [' ', ...bar(api, snapshot, windows[0].remaining)] : snapshot.status === 'ok' ? '' : `  ${snapshot.note ?? snapshot.status}`])]
  if (singleWindow) {
    children.push(el('text', { fg: api.theme.current.textMuted }, [formatReset(windows[0].resetAt)]))
  } else for (const window of windows) {
    children.push(el('text', { fg: tone(api, snapshot) }, [window.label.padEnd(8), ' ', ...bar(api, snapshot, window.remaining)]))
    children.push(el('text', { fg: api.theme.current.textMuted }, [formatReset(window.resetAt)]))
  }
  for (const fact of snapshot.facts ?? []) children.push(el('text', { fg: api.theme.current.textMuted }, [fact]))
  if (snapshot.status === 'ok' && snapshot.note) children.push(el('text', { fg: api.theme.current.textMuted }, [snapshot.note]))
  return el('box', { flexDirection: 'column', width: '100%', gap: 0, paddingBottom: 1 }, children)
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        const owner = getOwner()
        const cards = el('box', { flexDirection: 'column', width: '100%', gap: 0 }, [el('text', { fg: api.theme.current.textMuted }, ['Loading quota...'])])
        const root = el('box', { flexDirection: 'column', width: '100%', gap: 0, paddingTop: 1, paddingRight: 1 }, [el('text', { fg: api.theme.current.textMuted }, [el('b', {}, ['QUOTA'])]), cards])
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
              return snapshot ? [card(api, snapshot)] : []
            })
            insert(cards, null)
            insert(cards, rendered.length > 0 ? rendered : el('text', { fg: api.theme.current.textMuted }, ['Loading quota...']))
          })
        }
        const refresh = () => {
          for (const provider of providers) {
            void quota(provider, anthropicEnabled).then((snapshot) => {
              snapshots.set(provider, snapshot)
              render()
              if (snapshot.status === 'error' && !retryTimer) {
                retryTimer = setTimeout(() => {
                  retryTimer = undefined
                  refresh()
                }, 5000)
              }
            }).catch(() => {
              snapshots.set(provider, { provider, label: provider === 'github-copilot' ? 'Copilot' : provider === 'anthropic' ? 'Claude' : 'OpenAI', status: 'error', freshness: 'live', checkedAt: Date.now(), windows: [], note: 'quota refresh failed' })
              render()
            })
          }
        }
        refresh()
        const interval = setInterval(refresh, 60_000)
        onCleanup(() => {
          disposed = true
          clearInterval(interval)
          if (retryTimer) clearTimeout(retryTimer)
        })
        return root as unknown as Element
      },
    },
  })
}

export { invalidateQuotaCache } from './quota.js'

export default { id: 'lmasaya.opencode-quota', tui } satisfies TuiPluginModule & { id: string }
