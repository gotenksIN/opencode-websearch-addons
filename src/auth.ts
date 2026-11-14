import { awaitLookup, isJSONString, isRecord } from "./types.js";
import type { Credential, Plugin } from "./types.js";

export type IntegrationContext = Pick<
  Plugin.Context,
  "integration" | "provider"
>;

export const resolveCredential = async (
  ctx: IntegrationContext,
  integrationID: string,
  signal?: AbortSignal
): Promise<Credential.Value> => {
  const connection = await awaitLookup(
    async () => await ctx.integration.connection.active(integrationID),
    signal
  );

  if (!connection) {
    try {
      const provider = await awaitLookup(
        async () => await ctx.provider.get({ providerID: integrationID }),
        signal
      );

      const settings: unknown = provider?.data?.settings;

      const apiKey =
        settings !== undefined && isRecord(settings)
          ? settings.apiKey
          : undefined;

      if (
        apiKey !== undefined &&
        isJSONString(apiKey) &&
        apiKey.trim().length > 0
      ) {
        return { type: "key", key: apiKey.trim() };
      }
    } catch {
      signal?.throwIfAborted();
      // Fall back to standard connection error.
    }

    throw new Error(
      `No active ${integrationID} connection. Connect the ${integrationID} integration in OpenCode first.`
    );
  }

  let credential: Credential.Value | undefined;

  try {
    credential = await awaitLookup(
      async () => await ctx.integration.connection.resolve(connection),
      signal
    );
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      `Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`
    );
  }

  if (!credential) {
    throw new Error(
      `Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`
    );
  }

  return credential;
};
