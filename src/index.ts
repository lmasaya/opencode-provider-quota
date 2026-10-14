import { Plugin } from '@opencode/plugin'
import { providers, quota, type Auth, type Provider, type Snapshot } from './quota.js'
import { QuotaRpc } from './rpc.js'

function display({ facts: _facts, ...snapshot }: Snapshot) {
  return snapshot
}

export default Plugin.define({
  id: 'lmasaya.opencode-provider-quota',
  async setup(ctx) {
    // Credentials are resolved through OpenCode's integration API and stay in
    // the server process; they are never sent to clients or persisted.
    const loadAuth = async (provider: Provider): Promise<Auth | undefined> => {
      const connection = await ctx.integration.connection.active(provider)
      if (!connection) return undefined
      const credential = await ctx.integration.connection.resolve(connection)
      if (credential?.type !== 'oauth') return undefined
      const accountID = credential.metadata?.accountID
      return {
        access: credential.access,
        expires: credential.expires,
        accountId: typeof accountID === 'string' ? accountID : undefined,
      }
    }

    await ctx.rpc.register(QuotaRpc, {
      snapshots: async () => ({
        snapshots: (await Promise.all(providers.map((provider) => quota(provider, loadAuth)))).map(display),
      }),
    })
  },
})
