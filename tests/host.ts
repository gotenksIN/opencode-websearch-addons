import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Form } from "@opencode/core/form"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Tool } from "@opencode/core/tool"
import { WebSearchTool } from "@opencode/core/tool/plugin/websearch"
import { WebSearch } from "@opencode/core/websearch"
import { Agent } from "@opencode/core/agent"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionMessage } from "@opencode/core/session/message"
import type { Plugin } from "@opencode/plugin/effect"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Cause, Effect, Exit, Layer, References, Schema, Scope } from "effect"
import plugin from "../index.js"

const fixtureKey = "fixture-secret-123456"

const root = LayerNode.group([PluginHost.requirements, Form.node, Credential.node, Config.node])

export async function createHost(
  baseURL?: string,
  options: Plugin.Context["options"] = {},
  providerSettings?: ReadonlyMap<string, Provider.Settings>,
  readUserConfig = false,
) {
  const cache = join(import.meta.dir, "../.cache")
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, "websearch-host-"))
  const scope = await Effect.runPromise(Scope.make())
  let closed = false
  let failSettings = false

  const close = async () => {
    if (closed) return
    closed = true

    try {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  try {
    const isolatedGlobal = Global.layerWith({
      home: directory,
      data: join(directory, "data"),
      cache: join(directory, "cache"),
      config: join(directory, "config"),
      state: join(directory, "state"),
      tmp: join(directory, "tmp"),
      bin: join(directory, "bin"),
      log: join(directory, "log"),
      repos: join(directory, "repos"),
    })

    const globalLayer = readUserConfig
      ? Layer.effect(Global.Service, Effect.map(Global.Service, (isolated) => ({
        ...isolated,
        home: Global.make().home,
        config: process.env.OPENCODE_CONFIG_DIR ?? Global.make().config,
      }))).pipe(Layer.provide(isolatedGlobal))
      : isolatedGlobal

    const layer = AppNodeBuilder.build(root, [
      Global.node.replace(globalLayer),
      Config.node.replace(readUserConfig
        ? Config.configured({ global: true, project: false, system: false, claude: false })
        : Config.testLayer([])),
      Watcher.node.replace(Watcher.testLayer),
      Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
      Provider.node.replace(Provider.node.mapLayer((original) => Layer.effect(Provider.Service,
        Effect.gen(function* () {
          const service = yield* Provider.Service

          return {
            ...service,
            get: (id: Provider.ID) => failSettings ? Effect.die(new Error("fixture settings unavailable")) : service.get(id),
          }
        })).pipe(Layer.provide(original)))),
      Permission.node.replace(Permission.node.mapLayer((original) => Layer.effect(Permission.Service,
        Effect.gen(function* () {
          const service = yield* Permission.Service

          // Permission UI and session persistence are outside this capability
          // suite. All provider/tool execution still uses the real host.
          return { ...service, assert: () => Effect.void }
        })).pipe(Layer.provide(original)))),
    ])

    const services = await Effect.runPromise(Layer.buildWithScope(layer, scope).pipe(
      Effect.provideService(References.MinimumLogLevel, "None"),
    ))

    const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>, signal?: AbortSignal) =>
      Effect.runPromise(effect.pipe(
        Effect.provide(services), Scope.provide(scope),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ), { signal })

    const ctx = await run(PluginHost.make({ list: () => Effect.succeed([]) }, plugin.id))
    const providers = await run(Provider.Service)

    if (readUserConfig) {
      await run(ConfigProviderPlugin.Plugin.effect(ctx))
    } else await run(providers.transform((editor) => {
      for (const id of ["openai", "google"]) {
        const info = Provider.Info.empty(Provider.ID.make(id))
        const settings = providerSettings?.get(id) ?? { apiKey: fixtureKey, baseURL }
        editor.add({ info: { ...info, settings }, models: [] })
      }
    }))
    const pluginScope = await Effect.runPromise(Scope.make())
    await run(Effect.addFinalizer(() => Scope.close(pluginScope, Exit.void)))
    await run(PluginPromise.fromPromise(plugin).effect({
      ...ctx,
      options,
    }).pipe(Scope.provide(pluginScope)))
    await run(WebSearchTool.Plugin.effect(ctx))
    const websearch = await run(WebSearch.Service)
    const tools = await run(Tool.Service)
    const credentials = await run(Credential.Service)

    const queryEffect = (providerID?: string, query = "fixture query") =>
      websearch.query({ providerID: providerID === undefined ? undefined : WebSearch.ID.make(providerID), query })

    const failure = async (providerID?: string) => {
      const exit = await run(Effect.exit(queryEffect(providerID)))

      if (Exit.isSuccess(exit)) throw new Error("Expected a host request failure")
      const error = Cause.findErrorOption(exit.cause)

      if (error._tag === "Some") return error.value
      throw new Error("Host failed with a defect instead of a request error")
    }

    return {
      close,
      settings: async () => {
        const settings = new Map<string, Provider.Settings>()

        for (const id of ["openai", "google"]) {
          const info = await run(providers.get(Provider.ID.make(id)))

          if (info?.settings) settings.set(id, info.settings)
        }

        return settings
      },
      disposePlugin: () => Effect.runPromise(Scope.close(pluginScope, Exit.void)),
      query: (providerID: string, query?: string) => run(queryEffect(providerID, query)),
      queryExit: (providerID: string, signal: AbortSignal) => Effect.runPromiseExit(
        queryEffect(providerID).pipe(Effect.provide(services), Scope.provide(scope)), { signal }),
      failure,
      failureCause: async (providerID: string) => {
        const error = await failure(providerID)

        if (error instanceof WebSearch.RequestError && error.cause instanceof Error) return error.cause
        throw new Error("Expected a provider Error inside the host request failure")
      },
      selectRandom: () => run(websearch.select("random")),
      failSettings: () => { failSettings = true },
      credential: async (integrationID: string, value: PluginCredential) => {
        await run(credentials.create({
          integrationID: Integration.ID.make(integrationID),
          value: Schema.decodeUnknownSync(Credential.Value)(value),
        }))
      },
      render: async (providerID: string, query = "fixture query") => {
        await run(websearch.select(WebSearch.ID.make(providerID)))
        const tool = (await run(tools.list())).find((entry) => entry.name === "websearch")

        if (!tool) throw new Error("Built-in websearch tool is unavailable")

        return run(tool.execute({ query }, {
          sessionID: SessionSchema.ID.make("ses_fixture"),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_fixture"),
          id: Tool.CallID.make("fixture-call"),
          progress: () => Effect.void,
        }))
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}

type PluginCredential =
  | { readonly type: "key"; readonly key: string }
  | {
    readonly type: "oauth"; readonly methodID: string; readonly access: string; readonly refresh: string
    readonly expires: number; readonly metadata?: Record<string, string>
  }
  | { readonly type: "external"; readonly methodID: string }
