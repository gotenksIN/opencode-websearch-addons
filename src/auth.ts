import { awaitLookup, isJSONString, isRecord } from "./types.js"
import type { Credential, Plugin, ProviderSettingsContext } from "./types.js"

export type IntegrationContext = Pick<Plugin.Context, "integration"> & ProviderSettingsContext

export async function resolveCredential(
  ctx: IntegrationContext,
  integrationID: string,
  signal?: AbortSignal,
): Promise<Credential.Value> {
  const connection = await awaitLookup(() => ctx.integration.connection.active(integrationID), signal)

  if (!connection) {
    const lookup = ctx.provider ?? ctx.catalog?.provider

    if (lookup) {
      try {
        const provider = await awaitLookup(() => lookup.get({ providerID: integrationID }), signal)
        const settings = provider?.data?.settings
        const apiKey = settings !== undefined && isRecord(settings) ? settings["apiKey"] : undefined

        if (apiKey !== undefined && isJSONString(apiKey) && apiKey.trim().length > 0) {
          return { type: "key", key: apiKey.trim() }
        }
      } catch {
        signal?.throwIfAborted()
        // Fall back to standard connection error
      }
    }

    throw new Error(`No active ${integrationID} connection. Connect the ${integrationID} integration in OpenCode first.`)
  }

  let credential: Credential.Value | undefined

  try {
    credential = await awaitLookup(() => ctx.integration.connection.resolve(connection), signal)
  } catch {
    signal?.throwIfAborted()
    throw new Error(
      `Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`,
    )
  }

  if (!credential) {
    throw new Error(`Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`)
  }

  return credential
}
