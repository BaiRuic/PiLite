import {
  createModels,
  type AnyModel,
  type Api,
  type AuthCheck,
  type AuthContext,
  type AuthInteraction,
  type AuthOperationOptions,
  type AuthResult,
  type AuthType,
  type ClientIdentity,
  type Credential,
  type CredentialStore,
  type LoginOptions,
  type Model,
  type Models,
  type ModelsRefreshOptions,
  type ModelsRefreshResult,
  type ModelsStore,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { HarnessError, type ModelsProvider } from "../types.js";
import type { ConfigValueResolverOptions } from "./config-value.js";
import {
  createOpenAIEmbeddingProvider,
  type EmbeddingModel,
  type EmbeddingProvider,
  type OpenAIEmbeddingProviderOptions,
} from "./embedding.js";
import {
  composeLocalProvider,
  mergeLocalModelsConfigs,
  type LocalModelSource,
  type LocalModelsConfig,
} from "./local.js";

export interface CreateModelHubOptions {
  /** Persistent credential storage (OAuth tokens & API keys). Defaults to pi-ai's in-memory store. */
  readonly credentials?: CredentialStore;
  /** Persistent catalog cache for dynamically refreshed providers. Defaults to pi-ai's in-memory store. */
  readonly modelsStore?: ModelsStore;
  readonly authContext?: AuthContext;
  readonly identity?: ClientIdentity;
  /** Base providers (built-in OAuth/API providers, `createApiBackendProvider(...)`, etc.). */
  readonly providers?: readonly Provider<Api>[];
  /** Local model configuration sources (JSON files, DB settings, UI config, etc.) applied in order. */
  readonly localSources?: readonly LocalModelSource[];
  /** Optional statically registered embedding models (in addition to any declared in `localSources`). */
  readonly embeddingModels?: readonly EmbeddingModel[];
  /** Environment/command resolver options for `$ENV` (and optional opt-in `!command`) in local configs. */
  readonly configResolver?: Omit<ConfigValueResolverOptions, "signal">;
  /** Injectable `fetch` used by `discover: true` local providers. */
  readonly fetch?: typeof globalThis.fetch;
  /** Custom stream implementations for non-default wire APIs in local configs. */
  readonly apiStreams?: Partial<Record<Api, ProviderStreams>>;
}

export interface ModelHubInitOptions {
  /** Whether to hit the network during `init()` / `reload()`. Defaults to `false` (fast offline cache restore). */
  readonly allowNetwork?: boolean;
  readonly signal?: AbortSignal;
}

export interface LoginProviderInfo {
  readonly id: string;
  readonly name: string;
  readonly supportsOAuth: boolean;
  readonly supportsApiKeyLogin: boolean;
  readonly oauthLabel?: string;
}

/**
 * Unified model registry hub combining:
 * 1. Built-in OAuth/API providers (`pi-ai`),
 * 2. Custom API backend providers (`createApiBackendProvider`),
 * 3. Abstract local model sources (`LocalModelSource`),
 * with persistent `CredentialStore` + `ModelsStore` and hot-swap support for `HarnessSession`.
 */
export class ModelHub {
  private readonly credentials?: CredentialStore;
  private readonly modelsStore?: ModelsStore;
  private readonly authContext?: AuthContext;
  private readonly identity?: ClientIdentity;
  private readonly baseProviders = new Map<string, Provider<Api>>();
  private readonly registeredEmbeddingModels = new Map<string, EmbeddingModel>();
  private readonly localSources: LocalModelSource[];
  private readonly configResolver?: Omit<ConfigValueResolverOptions, "signal">;
  private readonly fetchImpl?: typeof globalThis.fetch;
  private readonly apiStreams?: Partial<Record<Api, ProviderStreams>>;

  private localConfig: LocalModelsConfig = { providers: {} };
  private activeModels: MutableModels;

  constructor(options: CreateModelHubOptions = {}) {
    this.credentials = options.credentials;
    this.modelsStore = options.modelsStore;
    this.authContext = options.authContext;
    this.identity = options.identity;
    this.localSources = [...(options.localSources ?? [])];
    this.configResolver = options.configResolver;
    this.fetchImpl = options.fetch;
    this.apiStreams = options.apiStreams;

    for (const provider of options.providers ?? []) {
      this.baseProviders.set(provider.id, provider);
    }
    for (const model of options.embeddingModels ?? []) {
      this.registeredEmbeddingModels.set(`${model.provider}\0${model.id}`, structuredClone(model));
    }

    this.activeModels = this.buildModelsInstance();
  }

  /** Current active `pi-ai` `Models` instance. */
  get models(): Models {
    return this.activeModels;
  }

  /**
   * Returns a hot-swappable `ModelsProvider` (`() => Models`) that can be passed
   * directly to `createSession({ models: hub.asModelsProvider(), ... })`.
   */
  asModelsProvider(): ModelsProvider {
    return () => this.activeModels;
  }

  /**
   * Load all configured `localSources`, rebuild providers, and restore cached
   * dynamic model catalogs (offline by default for fast startup).
   */
  async init(options: ModelHubInitOptions = {}): Promise<ModelsRefreshResult> {
    return this.reload(options);
  }

  /**
   * Reload all `localSources`, atomically swap the active `Models` instance,
   * and restore cached catalogs (optionally refreshing over the network).
   */
  async reload(options: ModelHubInitOptions = {}): Promise<ModelsRefreshResult> {
    const loaded: LocalModelsConfig[] = [];
    for (const source of this.localSources) {
      options.signal?.throwIfAborted();
      loaded.push(await source.load(options.signal));
    }
    this.localConfig = mergeLocalModelsConfigs(loaded);
    const next = this.buildModelsInstance();
    const result = await next.refresh({
      allowNetwork: options.allowNetwork ?? false,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.activeModels = next;
    return result;
  }

  /** Refresh dynamic providers (custom backends, `discover: true` local servers, OAuth catalogs). */
  refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
    return this.activeModels.refresh(options);
  }

  /** Run interactive OAuth or API-key login for a registered provider and persist credentials. */
  login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
    options?: LoginOptions,
  ): Promise<Credential> {
    return this.activeModels.login(providerId, type, interaction, options);
  }

  /** Remove persisted credentials for a provider. */
  logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.activeModels.logout(providerId, options);
  }

  /** Register or replace a base provider at runtime and recompute local overlays immediately. */
  setProvider(provider: Provider<Api>): void {
    this.baseProviders.set(provider.id, provider);
    this.activeModels = this.buildModelsInstance();
  }

  /** Remove a base provider at runtime. */
  removeProvider(providerId: string): void {
    this.baseProviders.delete(providerId);
    this.activeModels = this.buildModelsInstance();
  }

  getProviders(): readonly Provider<Api>[] {
    return this.activeModels.getProviders();
  }

  getProvider(id: string): Provider<Api> | undefined {
    return this.activeModels.getProvider(id);
  }

  getModels(providerId?: string): readonly Model<Api>[] {
    return this.activeModels.getModels(providerId);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.activeModels.getModel(providerId, modelId);
  }

  getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
    return this.activeModels.getAvailable(providerId, options);
  }

  checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
    return this.activeModels.checkAuth(providerId, options);
  }

  getAuth(providerId: string, overrides?: AuthOperationOptions): Promise<AuthResult | undefined>;
  getAuth(model: AnyModel, overrides?: AuthOperationOptions): Promise<AuthResult | undefined>;
  getAuth(
    providerOrModel: string | AnyModel,
    overrides?: AuthOperationOptions,
  ): Promise<AuthResult | undefined> {
    if (typeof providerOrModel === "string") {
      return this.activeModels.getAuth(providerOrModel, overrides);
    }
    return this.activeModels.getAuth(providerOrModel, overrides);
  }

  /** Register or update selectable embedding models programmatically (e.g. from a custom backend). */
  registerEmbeddingModels(models: readonly EmbeddingModel[]): void {
    for (const model of models) {
      this.registeredEmbeddingModels.set(`${model.provider}\0${model.id}`, structuredClone(model));
    }
  }

  /** Replace all programmatically registered embedding models for one provider. */
  setEmbeddingModels(providerId: string, models: readonly EmbeddingModel[]): void {
    for (const key of [...this.registeredEmbeddingModels.keys()]) {
      if (key.startsWith(`${providerId}\0`)) {
        this.registeredEmbeddingModels.delete(key);
      }
    }
    this.registerEmbeddingModels(models);
  }

  /** List all known embedding models (combining programmatic registrations and `localSources`). */
  getEmbeddingModels(providerId?: string): EmbeddingModel[] {
    const merged = new Map<string, EmbeddingModel>();
    for (const [key, model] of this.registeredEmbeddingModels) {
      if (providerId !== undefined && model.provider !== providerId) continue;
      merged.set(key, structuredClone(model));
    }

    for (const [pid, cfg] of Object.entries(this.localConfig.providers)) {
      if (providerId !== undefined && pid !== providerId) continue;
      if (!cfg.embeddingModels?.length) continue;
      const providerBaseUrl = cfg.baseUrl ?? this.activeModels.getProvider(pid)?.baseUrl ?? "";
      for (const def of cfg.embeddingModels) {
        const baseUrl = def.baseUrl ?? providerBaseUrl;
        if (!baseUrl) continue;
        merged.set(`${pid}\0${def.id}`, {
          id: def.id,
          name: def.name ?? def.id,
          provider: pid,
          baseUrl,
          ...(def.dimensions !== undefined ? { dimensions: def.dimensions } : {}),
          ...(def.maxInputTokens !== undefined ? { maxInputTokens: def.maxInputTokens } : {}),
          ...(def.headers ? { headers: { ...def.headers } } : {}),
        });
      }
    }

    return [...merged.values()];
  }

  /** Look up one embedding model by provider and model ID. */
  getEmbeddingModel(providerId: string, modelId: string): EmbeddingModel | undefined {
    return this.getEmbeddingModels(providerId).find((m) => m.id === modelId);
  }

  /** Return embedding models whose owning provider currently has configured auth (or keyless local access). */
  async getAvailableEmbeddingModels(
    providerId?: string,
    options?: AuthOperationOptions,
  ): Promise<EmbeddingModel[]> {
    const all = this.getEmbeddingModels(providerId);
    if (all.length === 0) return [];
    const providerIds = [...new Set(all.map((m) => m.provider))];
    const checks = await Promise.all(
      providerIds.map(async (pid) => [pid, Boolean(await this.checkAuth(pid, options))] as const),
    );
    const configured = new Set(checks.filter(([, ok]) => ok).map(([pid]) => pid));
    return all.filter((m) => configured.has(m.provider));
  }

  /**
   * Instantiate an `EmbeddingProvider` for a selected `(providerId, modelId)`,
   * automatically reusing this hub's auth (API key, JWT, OAuth, headers, baseUrl).
   */
  createEmbeddingProvider(
    providerId: string,
    modelId: string,
    overrides: Partial<
      Omit<OpenAIEmbeddingProviderOptions, "modelId" | "authFrom" | "model">
    > = {},
  ): EmbeddingProvider {
    const known = this.getEmbeddingModel(providerId, modelId);
    const registeredProvider = this.activeModels.getProvider(providerId);
    if (!known && !registeredProvider && !overrides.baseUrl) {
      throw new HarnessError(
        "MODEL_NOT_FOUND",
        `Embedding model "${providerId}/${modelId}" is not registered and provider "${providerId}" was not found.`,
      );
    }

    const baseUrl = overrides.baseUrl ?? known?.baseUrl ?? registeredProvider?.baseUrl;
    return createOpenAIEmbeddingProvider({
      id: providerId,
      modelId,
      ...(known ? { model: known } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(registeredProvider ? { authFrom: { models: this, providerId } } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      ...(this.configResolver ? { configResolver: this.configResolver } : {}),
      ...overrides,
    });
  }

  /** List providers that support interactive OAuth or API-key login flows. */
  listLoginProviders(): LoginProviderInfo[] {
    const result: LoginProviderInfo[] = [];
    for (const provider of this.activeModels.getProviders()) {
      const supportsOAuth = Boolean(provider.auth.oauth);
      const supportsApiKeyLogin = Boolean(provider.auth.apiKey?.login);
      if (!supportsOAuth && !supportsApiKeyLogin) continue;
      result.push({
        id: provider.id,
        name: provider.name,
        supportsOAuth,
        supportsApiKeyLogin,
        ...(provider.auth.oauth?.loginLabel ? { oauthLabel: provider.auth.oauth.loginLabel } : {}),
      });
    }
    return result;
  }

  private buildModelsInstance(): MutableModels {
    const models = createModels({
      ...(this.credentials ? { credentials: this.credentials } : {}),
      ...(this.modelsStore ? { modelsStore: this.modelsStore } : {}),
      ...(this.authContext ? { authContext: this.authContext } : {}),
      ...(this.identity ? { identity: this.identity } : {}),
    });

    const allIds = new Set<string>([
      ...this.baseProviders.keys(),
      ...Object.keys(this.localConfig.providers),
    ]);

    for (const providerId of allIds) {
      const base = this.baseProviders.get(providerId);
      const local = this.localConfig.providers[providerId];
      const composed = local
        ? composeLocalProvider(providerId, base, local, {
            configResolver: this.configResolver,
            fetch: this.fetchImpl,
            apiStreams: this.apiStreams,
          })
        : base;
      if (composed) {
        models.setProvider(composed);
      }
    }

    return models;
  }
}

export function createModelHub(options?: CreateModelHubOptions): ModelHub {
  return new ModelHub(options);
}
