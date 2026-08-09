import type { Credential, Plugin } from "@opencode-ai/plugin"

export type IntegrationContext = Pick<Plugin.Context, "integration">

export async function resolveCredential(
  ctx: IntegrationContext,
  integrationID: string,
): Promise<Credential.Value> {
  const connection = await ctx.integration.connection.active(integrationID)
  if (!connection) {
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
