import { isJSONString, isRecord } from "./types.js"
import type { Credential, Plugin, ProviderSettingsContext } from "./types.js"

export type IntegrationContext = Pick<Plugin.Context, "integration"> & ProviderSettingsContext

export async function resolveCredential(
  ctx: IntegrationContext,
  integrationID: string,
): Promise<Credential.Value> {
  const connection = await ctx.integration.connection.active(integrationID)

  if (!connection) {
    const lookup = ctx.provider ?? ctx.catalog?.provider

    if (lookup) {
      try {
        const provider = await lookup.get({ providerID: integrationID })
        const settings = provider?.data?.settings
        const apiKey = settings !== undefined && isRecord(settings) ? settings["apiKey"] : undefined

        if (apiKey !== undefined && isJSONString(apiKey) && apiKey.trim().length > 0) {
          return { type: "key", key: apiKey.trim() }
        }
      } catch {
        // Fall back to standard connection error
      }
    }

    throw new Error(`No active ${integrationID} connection. Connect the ${integrationID} integration in OpenCode first.`)
  }

  let credential: Credential.Value | undefined

  try {
    credential = await ctx.integration.connection.resolve(connection)
  } catch {
    throw new Error(
      `Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`,
    )
  }

  if (!credential) {
    throw new Error(`Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`)
  }

  return credential
}
