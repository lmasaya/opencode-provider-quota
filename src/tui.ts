import { createElement, insert, setProp } from '@opentui/solid'
import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { onCleanup } from 'solid-js'
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
  if (snapshot.status !== 'ok') return api.theme.current.textMuted
  const remaining = snapshot.windows[0]?.remaining ?? 0
  if (remaining <= 5) return api.theme.current.error
  if (remaining <= 30) return api.theme.current.warning
  return api.theme.current.success
}

function providerColor(api: Parameters<TuiPlugin>[0], provider: Snapshot['provider']) {
  if (provider === 'github-copilot') return api.theme.current.success
  if (provider === 'anthropic') return api.theme.current.warning
  return api.theme.current.info
}

function bar(api: Parameters<TuiPlugin>[0], snapshot: Snapshot, remaining: number) {
  const width = 16
  const percent = `${Math.round(remaining)}%`
  const filled = Math.round((remaining / 100) * width)
  const before = Math.max(0, Math.floor((width - percent.length) / 2))
  const after = width - before - percent.length
  const color = providerColor(api, snapshot.provider)
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
  const children: unknown[] = [el('text', { fg: tone(api, snapshot) }, [el('b', {}, [snapshot.label]), snapshot.status === 'ok' ? '' : `  ${snapshot.note ?? snapshot.status}`])]
  for (const window of snapshot.windows.slice(0, 2)) {
    children.push(el('text', { fg: tone(api, snapshot) }, [window.label.padEnd(8), ' ', ...bar(api, snapshot, window.remaining)]))
    children.push(el('text', { fg: api.theme.current.textMuted }, [formatReset(window.resetAt)]))
  }
  for (const fact of snapshot.facts ?? []) children.push(el('text', { fg: api.theme.current.textMuted }, [fact]))
  if (snapshot.status === 'ok' && snapshot.note) children.push(el('text', { fg: api.theme.current.textMuted }, [snapshot.note]))
  return el('box', { gap: 0, paddingBottom: 1 }, children)
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        const cards = el('box', { gap: 0 })
        const root = el('box', { gap: 0, paddingTop: 1, paddingRight: 1 }, [el('text', { fg: api.theme.current.textMuted }, [el('b', {}, ['QUOTA'])]), cards])
        let disposed = false
        const refresh = () => {
          void Promise.all(providers.map((provider) => quota(provider, anthropicEnabled))).then((snapshots) => {
            if (disposed) return
            insert(cards, null)
            insert(cards, snapshots.map((snapshot) => card(api, snapshot)))
          })
        }
        refresh()
        const interval = setInterval(refresh, 60_000)
        onCleanup(() => {
          disposed = true
          clearInterval(interval)
        })
        return root as unknown as Element
      },
    },
  })
}

export default { id: 'lmasaya.opencode-quota', tui } satisfies TuiPluginModule & { id: string }
