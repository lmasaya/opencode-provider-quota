/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { createSignal, For, onCleanup, Show } from 'solid-js'
import { formatReset, quota, type Snapshot } from './quota.js'

const PROVIDERS = ['openai', 'github-copilot', 'anthropic'] as const
const ANTHROPIC_ENABLED = process.env.OPENCODE_QUOTA_ENABLE_ANTHROPIC === '1'

function tone(api: Parameters<TuiPlugin>[0], snapshot: Snapshot) {
  if (snapshot.status !== 'ok') return api.theme.current.textMuted
  const remaining = snapshot.windows[0]?.remaining ?? 0
  if (remaining <= 5) return api.theme.current.error
  if (remaining <= 30) return api.theme.current.warning
  return api.theme.current.success
}

function bar(remaining: number, width = 16) {
  const percent = `${Math.round(remaining)}%`
  const filled = Math.round((remaining / 100) * width)
  const start = Math.max(0, Math.floor((width - percent.length) / 2))
  return {
    before: start,
    percent,
    after: width - start - percent.length,
    filled,
  }
}

function providerColor(api: Parameters<TuiPlugin>[0], provider: Snapshot['provider']) {
  if (provider === 'github-copilot') return api.theme.current.success
  if (provider === 'anthropic') return api.theme.current.warning
  return api.theme.current.info
}

function BarSegment(props: { start: number; length: number; filled: number; color: ReturnType<typeof providerColor> }) {
  const colored = Math.max(0, Math.min(props.length, props.filled - props.start))
  const empty = props.length - colored
  return <><Show when={colored > 0}><span style={{ bg: props.color }}>{' '.repeat(colored)}</span></Show><Show when={empty > 0}><span>{' '.repeat(empty)}</span></Show></>
}

function ProviderCard(props: { api: Parameters<TuiPlugin>[0]; snapshot: Snapshot }) {
  const detail = () => props.snapshot.windows.slice(0, 2)
  return (
    <box gap={0} paddingBottom={1}>
      <text fg={tone(props.api, props.snapshot)}>
        <b>{props.snapshot.label}</b>
        <Show when={props.snapshot.status !== 'ok'}>{`  ${props.snapshot.note}`}</Show>
      </text>
      <For each={detail()}>{(window) => {
        const display = bar(window.remaining)
        const color = providerColor(props.api, props.snapshot.provider)
        return <box gap={0}><text fg={tone(props.api, props.snapshot)}>{window.label.padEnd(8)} [<BarSegment start={0} length={display.before} filled={display.filled} color={color} /><span style={{ fg: '#000000', bg: color }}><b>{display.percent}</b></span><BarSegment start={display.before + display.percent.length} length={display.after} filled={display.filled} color={color} />]</text><text fg={props.api.theme.current.textMuted}>{formatReset(window.resetAt)}</text></box>
      }}</For>
      <For each={props.snapshot.facts}>{(fact) => <text fg={props.api.theme.current.textMuted}>{fact}</text>}</For>
      <Show when={props.snapshot.status === 'ok' && props.snapshot.note}><text fg={props.api.theme.current.textMuted}>{props.snapshot.note}</text></Show>
    </box>
  )
}

function Sidebar(props: { api: Parameters<TuiPlugin>[0] }) {
  const [snapshots, setSnapshots] = createSignal<Snapshot[]>([])
  let disposed = false
  const refresh = () => {
    void Promise.all(PROVIDERS.map((provider) => quota(provider, ANTHROPIC_ENABLED))).then((next) => {
      if (!disposed) setSnapshots(next)
    })
  }
  refresh()
  const interval = setInterval(refresh, 60_000)
  onCleanup(() => {
    disposed = true
    clearInterval(interval)
  })
  return <box gap={0} paddingTop={1} paddingRight={1}><text fg={props.api.theme.current.textMuted}><b>QUOTA</b></text><For each={snapshots()}>{(snapshot) => <ProviderCard api={props.api} snapshot={snapshot} />}</For></box>
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        return <Sidebar api={api} />
      },
    },
  })
}

export default { id: 'lmasaya.opencode-quota', tui } satisfies TuiPluginModule & { id: string }
