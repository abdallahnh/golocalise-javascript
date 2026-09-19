import {
  parseOtaArtifact,
  parseOtaManifest,
  type OtaArtifact,
  type OtaManifest,
  type OtaMessage,
  type OtaPluralMessage,
} from './protocol.js';

export interface OtaHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
}

export interface OtaTransport {
  request(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }): Promise<OtaHttpResponse>;
}

export interface PersistentCacheAdapter {
  read(key: string): Promise<string | null>;
  writeAtomic(key: string, value: string): Promise<void>;
}

export interface BundledTranslationAdapter {
  get(locale: string, namespace: string, key: string): OtaMessage | undefined;
}

export interface GoLocaliseClientConfig {
  readonly baseUrl: string;
  readonly token: string;
  readonly projectId: string;
  readonly environment: string;
  readonly locale: string;
  readonly transport?: OtaTransport;
  readonly cache?: PersistentCacheAdapter;
  readonly bundled?: BundledTranslationAdapter;
  readonly timeoutMs?: number;
  readonly refreshPolicy?: {
    readonly refreshOnInitialize?: boolean;
  };
}

export type RefreshResult =
  | { readonly status: 'updated'; readonly release: number }
  | { readonly status: 'unchanged'; readonly release: number | null }
  | { readonly status: 'failed'; readonly error: string };

export type TranslationSource = 'ota' | 'bundled' | 'fallback' | 'key';
export interface TranslationEntry {
  readonly key: string;
  readonly namespace: string;
  readonly value: OtaMessage;
}
export interface TranslationLookup {
  readonly key: string;
  readonly namespace: string;
  readonly value: string;
  readonly source: TranslationSource;
  readonly locale: string;
  readonly release: number | null;
}

interface CacheEnvelope {
  readonly manifest: OtaManifest;
  readonly manifestEtag: string | null;
  readonly artifact: OtaArtifact;
}

export class MemoryCacheAdapter implements PersistentCacheAdapter {
  private readonly entries = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null;
  }

  async writeAtomic(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }
}

export class FetchTransport implements OtaTransport {
  async request(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }): Promise<OtaHttpResponse> {
    const response = await fetch(input.url, {
      method: 'GET',
      headers: input.headers,
      signal: input.signal,
    });
    return {
      status: response.status,
      headers: {
        etag: response.headers.get('etag') ?? undefined,
      },
      ...(response.status === 304 ? {} : { body: await response.text() }),
    };
  }
}

export class GoLocaliseClient {
  private locale: string;
  private state: CacheEnvelope | null = null;
  private refreshInFlight: Promise<RefreshResult> | null = null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly transport: OtaTransport;
  private readonly cache: PersistentCacheAdapter;

  constructor(private readonly config: GoLocaliseClientConfig) {
    this.baseUrl = normalizedBaseUrl(config.baseUrl);
    if (!config.token.startsWith('gl_sdk_')) {
      throw new Error('A public gl_sdk_ credential is required');
    }
    if (!config.projectId || !config.environment || !config.locale) {
      throw new Error('projectId, environment, and locale are required');
    }
    this.locale = normalizeLocale(config.locale);
    this.timeoutMs = config.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('timeoutMs must be a positive integer');
    }
    this.transport = config.transport ?? new FetchTransport();
    this.cache = config.cache ?? new MemoryCacheAdapter();
  }

  async initialize(): Promise<RefreshResult> {
    await this.loadCachedLocale();
    if (this.config.refreshPolicy?.refreshOnInitialize === false) {
      return {
        status: 'unchanged',
        release: this.state?.manifest.release ?? null,
      };
    }
    return this.refresh();
  }

  refresh(): Promise<RefreshResult> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.performRefresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  async setLocale(locale: string, refresh = true): Promise<RefreshResult> {
    if (!locale) throw new Error('locale is required');
    this.locale = normalizeLocale(locale);
    this.state = null;
    await this.loadCachedLocale();
    return refresh
      ? this.refresh()
      : { status: 'unchanged', release: this.currentRelease };
  }

  t(
    key: string,
    options: {
      readonly namespace?: string;
      readonly fallback?: string;
      readonly arguments?: readonly (string | number)[];
      readonly count?: number;
    } = {},
  ): string {
    const namespace = options.namespace ?? 'default';
    const value =
      this.state?.artifact.namespaces[namespace]?.[key] ??
      this.config.bundled?.get(this.locale, namespace, key) ??
      options.fallback ??
      key;
    const resolved =
      typeof value === 'string'
        ? value
        : selectPluralMessage(value, this.locale, options.count);
    return options.arguments
      ? formatCanonicalMessage(resolved, options.arguments)
      : resolved;
  }

  /** Returns keys from the validated current-locale artifact only. */
  keys(namespace?: string): string[] {
    const namespaces = namespace
      ? [namespace]
      : Object.keys(this.state?.artifact.namespaces ?? {});
    return namespaces
      .flatMap((name) =>
        Object.keys(this.state?.artifact.namespaces[name] ?? {}),
      )
      .sort();
  }

  namespaces(): string[] {
    return Object.keys(this.state?.artifact.namespaces ?? {}).sort();
  }

  translations(namespace?: string): TranslationEntry[] {
    const names = namespace ? [namespace] : this.namespaces();
    return names
      .flatMap((name) =>
        Object.entries(this.state?.artifact.namespaces[name] ?? {}).map(
          ([key, value]) => ({ key, namespace: name, value }),
        ),
      )
      .sort(
        (a, b) =>
          a.namespace.localeCompare(b.namespace) || a.key.localeCompare(b.key),
      );
  }

  lookup(
    key: string,
    options: {
      readonly namespace?: string;
      readonly fallback?: string;
      readonly count?: number;
    } = {},
  ): TranslationLookup {
    const namespace = options.namespace ?? 'default';
    const ota = this.state?.artifact.namespaces[namespace]?.[key];
    const bundled = this.config.bundled?.get(this.locale, namespace, key);
    const value = this.t(key, options);
    return {
      key,
      namespace,
      value,
      source:
        ota !== undefined
          ? 'ota'
          : bundled !== undefined
            ? 'bundled'
            : options.fallback !== undefined
              ? 'fallback'
              : 'key',
      locale: this.locale,
      release: this.currentRelease,
    };
  }

  async supportedLocales(): Promise<string[]> {
    const response = await this.request(this.localesUrl());
    this.requireSuccess(response, 'locales');
    const payload = parseJson(response.body, 'locales');
    if (!Array.isArray(payload))
      throw new Error('locales response is malformed');
    return payload.filter(
      (locale): locale is string =>
        typeof locale === 'string' && locale.length > 0,
    );
  }

  get currentRelease(): number | null {
    return this.state?.manifest.release ?? null;
  }

  get currentLocale(): string {
    return this.locale;
  }

  private async performRefresh(): Promise<RefreshResult> {
    try {
      const manifestResponse = await this.request(
        this.manifestUrl(),
        this.state?.manifestEtag
          ? { 'If-None-Match': this.state.manifestEtag }
          : {},
      );
      if (manifestResponse.status === 304) {
        return { status: 'unchanged', release: this.currentRelease };
      }
      this.requireSuccess(manifestResponse, 'manifest');
      const manifest = parseOtaManifest(
        parseJson(manifestResponse.body, 'manifest'),
      );
      this.validateManifestScope(manifest);
      const localeEntry = manifest.locales[this.locale];
      if (!localeEntry)
        throw new Error('Manifest does not contain requested locale');
      if (this.state && manifest.release < this.state.manifest.release) {
        return { status: 'unchanged', release: this.state.manifest.release };
      }
      if (this.state && manifest.release === this.state.manifest.release) {
        if (
          localeEntry.hash !== this.state.manifest.locales[this.locale]?.hash
        ) {
          throw new Error('Same release returned different artifact hash');
        }
        return { status: 'unchanged', release: manifest.release };
      }
      const artifactUrl = new URL(localeEntry.url, this.baseUrl);
      if (artifactUrl.origin !== new URL(this.baseUrl).origin) {
        throw new Error('Cross-origin artifact URL rejected');
      }
      const artifactResponse = await this.request(artifactUrl.toString());
      this.requireSuccess(artifactResponse, 'artifact');
      const body = artifactResponse.body ?? '';
      if (new TextEncoder().encode(body).byteLength !== localeEntry.size) {
        throw new Error('Artifact size mismatch');
      }
      if ((await sha256(body)) !== localeEntry.hash) {
        throw new Error('Artifact hash mismatch');
      }
      const artifact = parseOtaArtifact(parseJson(body, 'artifact'));
      this.validateArtifactScope(artifact, manifest);
      const nextState: CacheEnvelope = {
        manifest,
        manifestEtag: manifestResponse.headers.etag ?? null,
        artifact,
      };
      await this.cache.writeAtomic(this.cacheKey(), JSON.stringify(nextState));
      this.state = nextState;
      return { status: 'updated', release: manifest.release };
    } catch (error) {
      return {
        status: 'failed',
        error:
          error instanceof Error ? error.message : 'Unknown OTA refresh error',
      };
    }
  }

  private async loadCachedLocale(): Promise<void> {
    try {
      const stored = await this.cache.read(this.cacheKey());
      if (!stored) return;
      const input = parseJson(stored, 'cache') as Partial<CacheEnvelope>;
      const manifest = parseOtaManifest(input.manifest);
      const artifact = parseOtaArtifact(input.artifact);
      this.validateManifestScope(manifest);
      this.validateArtifactScope(artifact, manifest);
      this.state = {
        manifest,
        artifact,
        manifestEtag:
          typeof input.manifestEtag === 'string' ? input.manifestEtag : null,
      };
    } catch {
      this.state = null;
    }
  }

  private async request(
    url: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<OtaHttpResponse> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.transport.request({
          url,
          headers: { Authorization: `Bearer ${this.config.token}`, ...headers },
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('OTA request timed out'));
          }, this.timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private requireSuccess(response: OtaHttpResponse, resource: string): void {
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `${resource} request failed with HTTP ${response.status}`,
      );
    }
  }

  private validateManifestScope(manifest: OtaManifest): void {
    if (
      manifest.projectId !== this.config.projectId ||
      manifest.environment !== this.config.environment
    ) {
      throw new Error('Manifest scope mismatch');
    }
  }

  private validateArtifactScope(
    artifact: OtaArtifact,
    manifest: OtaManifest,
  ): void {
    if (
      artifact.projectId !== this.config.projectId ||
      artifact.environment !== this.config.environment ||
      artifact.locale !== this.locale ||
      artifact.release !== manifest.release
    ) {
      throw new Error('Artifact scope mismatch');
    }
  }

  private manifestUrl(): string {
    const path = [
      'ota/v1/projects',
      encodeURIComponent(this.config.projectId),
      'environments',
      encodeURIComponent(this.config.environment),
      'manifest',
    ].join('/');
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('locale', this.locale);
    return url.toString();
  }

  private localesUrl(): string {
    return new URL(
      [
        'ota/v1/projects',
        encodeURIComponent(this.config.projectId),
        'environments',
        encodeURIComponent(this.config.environment),
        'locales',
      ].join('/'),
      this.baseUrl,
    ).toString();
  }

  private cacheKey(): string {
    return [
      'golocalise-v1',
      this.config.projectId,
      this.config.environment,
      this.locale,
    ].join(':');
  }
}

export function selectPluralMessage(
  message: OtaPluralMessage,
  locale: string,
  count: number | undefined,
): string {
  if (count === undefined || !Number.isFinite(count))
    return message.forms.other;
  const category = new Intl.PluralRules(normalizeLocale(locale)).select(count);
  const form = message.forms[category] ?? message.forms.other;
  return formatNamedArgument(form, message.variable, count);
}

function normalizeLocale(locale: string): string {
  try {
    const canonical = Intl.getCanonicalLocales(locale.replaceAll('_', '-'))[0];
    if (!canonical) throw new RangeError('Invalid locale');
    return canonical;
  } catch {
    throw new Error(`Invalid locale: ${locale}`);
  }
}

function formatNamedArgument(
  message: string,
  variable: string,
  value: string | number,
): string {
  let malformed = false;
  const output = message.replace(
    /\{\{|\}\}|\{([^{}]+)\}|[{}]/gu,
    (token, name) => {
      if (token === '{{') return '\u0000';
      if (token === '}}') return '\u0001';
      if (name === variable) return String(value);
      if (name !== undefined && /^\d+$/u.test(name)) return token;
      malformed = true;
      return token;
    },
  );
  return malformed
    ? message
    : output.replaceAll('\u0000', '{').replaceAll('\u0001', '}');
}

export function formatCanonicalMessage(
  message: string,
  arguments_: readonly (string | number)[],
): string {
  const indexes = new Set<number>();
  for (const match of message.matchAll(/\{(\d+)\}/gu)) {
    indexes.add(Number(match[1]));
  }
  const oneBased =
    !indexes.has(0) &&
    indexes.size > 0 &&
    Math.min(...indexes) === 1 &&
    Math.max(...indexes) === arguments_.length;
  let malformed = false;
  const output = message.replace(
    /\{\{|\}\}|\{(\d+)\}|[{}]/gu,
    (token, rawIndex) => {
      if (token === '{{') return '\u0000';
      if (token === '}}') return '\u0001';
      if (rawIndex === undefined) {
        malformed = true;
        return token;
      }
      const index = Number(rawIndex);
      indexes.add(index);
      const argumentIndex = oneBased ? index - 1 : index;
      return argumentIndex >= 0 && argumentIndex < arguments_.length
        ? String(arguments_[argumentIndex])
        : token;
    },
  );
  const expected = new Set(
    arguments_.map((_, index) => (oneBased ? index + 1 : index)),
  );
  if (
    malformed ||
    indexes.size !== expected.size ||
    [...indexes].some((index) => !expected.has(index))
  ) {
    return message;
  }
  return output.replaceAll('\u0000', '{').replaceAll('\u0001', '}');
}

export function createClient(config: GoLocaliseClientConfig): GoLocaliseClient {
  return new GoLocaliseClient(config);
}

function normalizedBaseUrl(input: string): string {
  const url = new URL(input);
  const localHttp =
    url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('baseUrl must use HTTPS except on localhost');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function parseJson(input: string | undefined, resource: string): unknown {
  if (input === undefined)
    throw new Error(`${resource} response body is missing`);
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw new Error(`${resource} response is malformed JSON`);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}
