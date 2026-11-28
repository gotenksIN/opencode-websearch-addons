import { Provider } from "@opencode/plugin/effect";
import { Effect, Redacted } from "effect";

import { isJSONString, isRecord } from "./types.js";
import type { Credential, Plugin } from "./types.js";

export type IntegrationContext = Pick<
  Plugin.Context,
  "integration" | "provider"
>;

export type ResolvedCredential =
  | {
      readonly type: "key";
      readonly key: Redacted.Redacted;
    }
  | {
      readonly type: "oauth";
      readonly methodID: string;
      readonly access: Redacted.Redacted;
      readonly refresh: Redacted.Redacted;
      readonly accountID?: string;
    }
  | {
      readonly type: "other";
    };

const extractAccountID = (credential: Credential.OAuth) => {
  const { metadata } = credential;

  const account = isRecord(metadata)
    ? (metadata.accountID ?? metadata.accountId)
    : "";

  return isJSONString(account) && account.length > 0 ? account : undefined;
};

const toResolvedCredential = (credential: Credential.Value) => {
  let resolved: ResolvedCredential = { type: "other" };

  if (credential.type === "key") {
    resolved = {
      type: "key",
      key: Redacted.make(credential.key),
    };
  } else if (credential.type === "oauth") {
    const accountID = extractAccountID(credential);

    const base = {
      type: "oauth",
      methodID: credential.methodID,
      access: Redacted.make(credential.access),
      refresh: Redacted.make(credential.refresh),
    } as const;

    resolved = accountID === undefined ? base : { ...base, accountID };
  }

  return resolved;
};

export const resolveCredential = Effect.fnUntraced(function* resolveCredential(
  ctx: IntegrationContext,
  integrationID: string
) {
  const connection = yield* ctx.integration.connection.active(integrationID);

  if (!connection) {
    const provider = yield* ctx.provider
      .get({ providerID: Provider.ID.make(integrationID) })
      .pipe(Effect.catch(() => Effect.succeed(undefined)));

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
      return {
        type: "key",
        key: Redacted.make(apiKey.trim()),
      } satisfies ResolvedCredential;
    }

    return yield* Effect.fail(
      new Error(
        `No active ${integrationID} connection. Connect the ${integrationID} integration in OpenCode first.`
      )
    );
  }

  const credential = yield* ctx.integration.connection
    .resolve(connection)
    .pipe(
      Effect.mapError(
        () =>
          new Error(
            `Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`
          )
      )
    );

  if (!credential) {
    return yield* Effect.fail(
      new Error(
        `Unable to resolve ${integrationID} credentials. Reconnect the ${integrationID} integration and try again.`
      )
    );
  }

  return toResolvedCredential(credential);
});
