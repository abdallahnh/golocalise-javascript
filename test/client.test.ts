import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/golden.json', import.meta.url), 'utf8'),
) as {
  projectId: string;
  environment: string;
  namespace: string;
  key: string;
  englishA: string;
  arabicA: string;
  englishB: string;
  arabicB: string;
};
import { describe, expect, it } from 'vitest';
import {
  MemoryCacheAdapter,
  createClient,
  formatCanonicalMessage,
  selectPluralMessage,
  type OtaHttpResponse,
  type OtaTransport,
  type PersistentCacheAdapter,
} from '../src/index.js';

describe('canonical interpolation', () => {
  it('formats positional values, escaped braces, Unicode, and fails safely', () => {
    expect(formatCanonicalMessage('{0} → {1}', ['مرحبا', 'World'])).toBe(
      'مرحبا → World',
    );
    expect(formatCanonicalMessage('{1} then {0}', ['first', 'second'])).toBe(
      'second then first',
    );
    expect(formatCanonicalMessage('Testing {1} and {2}', ['one', 'two'])).toBe(
      'Testing one and two',
    );
    expect(formatCanonicalMessage('{{{0}}}', ['value'])).toBe('{value}');
    expect(formatCanonicalMessage('{0} {2}', ['one', 'two'])).toBe('{0} {2}');
    expect(formatCanonicalMessage('{0', ['one'])).toBe('{0');
  });

  it('selects English and Arabic plural categories and preserves Unicode', () => {
    const message = {
      type: 'plural' as const,
      variable: 'count',
      forms: {
        zero: 'لا عناصر',
        one: 'عنصر واحد',
        two: 'عنصران',
        few: '{count} عناصر',
        many: '{count} عنصراً',
        other: '{count} عنصر',
      },
    };
    expect(selectPluralMessage(message, 'ar', 0)).toBe('لا عناصر');
    expect(selectPluralMessage(message, 'ar', 2)).toBe('عنصران');
    expect(selectPluralMessage(message, 'ar', 7)).toBe('7 عناصر');
    expect(selectPluralMessage(message, 'ar', 15)).toBe('15 عنصراً');
    expect(selectPluralMessage(message, 'ar', 100)).toBe('100 عنصر');
    expect(selectPluralMessage(message, 'ar_lb', 2)).toBe('عنصران');
  });

  it('canonicalizes regional locale variants at SDK boundaries', async () => {
    const sdk = client(new QueueTransport(), {
      locale: 'AR_lb',
      refreshOnInitialize: false,
    });
    expect(sdk.currentLocale).toBe('ar-LB');
    await expect(sdk.setLocale('ar_iq', false)).resolves.toEqual({
      status: 'unchanged',
      release: null,
    });
    expect(sdk.currentLocale).toBe('ar-IQ');
  });
});

type RequestInput = Parameters<OtaTransport['request']>[0];
type QueueItem =
  | OtaHttpResponse
  | Error
  | ((input: RequestInput) => Promise<OtaHttpResponse>);

class QueueTransport implements OtaTransport {
  readonly requests: RequestInput[] = [];
  readonly queue: QueueItem[] = [];

  enqueue(...items: QueueItem[]): void {
    this.queue.push(...items);
  }

  async request(input: RequestInput): Promise<OtaHttpResponse> {
    this.requests.push(input);
    const item = this.queue.shift();
    if (!item) throw new Error('offline');
    if (item instanceof Error) throw item;
    return typeof item === 'function' ? item(input) : item;
  }
}

class InterruptibleCache implements PersistentCacheAdapter {
  private readonly delegate = new MemoryCacheAdapter();
  failWrites = false;

  read(key: string): Promise<string | null> {
    return this.delegate.read(key);
  }

  async writeAtomic(key: string, value: string): Promise<void> {
    if (this.failWrites) throw new Error('interrupted atomic cache write');
    await this.delegate.writeAtomic(key, value);
  }
}

function hash(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function release(
  version: number,
  locale: 'en' | 'ar',
  value:
    | string
    | {
        type: 'plural';
        variable: string;
        forms: {
          other: string;
          one?: string;
          zero?: string;
          two?: string;
          few?: string;
          many?: string;
        };
      },
  overrides: Record<string, unknown> = {},
) {
  const artifact = {
    environment: fixture.environment,
    locale,
    namespaces: { [fixture.namespace]: { [fixture.key]: value } },
    projectId: fixture.projectId,
    protocolVersion: 1,
    release: version,
    ...overrides,
  };
  const artifactBody = JSON.stringify(artifact);
  const contentHash = hash(artifactBody);
  const manifest = {
    protocolVersion: 1,
    projectId: fixture.projectId,
    environment: fixture.environment,
    release: version,
    generatedAt: `2026-09-10T00:00:0${version}.000Z`,
    locales: {
      [locale]: {
        hash: contentHash,
        url: `/releases/${version}/${locale}.${contentHash.slice(7)}.json`,
        size: new TextEncoder().encode(artifactBody).byteLength,
      },
    },
  };
  return {
    manifest,
    artifactBody,
    manifestResponse: response(200, JSON.stringify(manifest), {
      etag: `"manifest-${version}-${locale}"`,
    }),
    artifactResponse: response(200, artifactBody),
  };
}

function response(
  status: number,
  body?: string,
  headers: Record<string, string> = {},
): OtaHttpResponse {
  return { status, headers, ...(body === undefined ? {} : { body }) };
}

function client(
  transport: OtaTransport,
  options: {
    locale?: string;
    cache?: PersistentCacheAdapter;
    timeoutMs?: number;
    bundled?: {
      get(
        locale: string,
        namespace: string,
        key: string,
      ):
        | string
        | {
            type: 'plural';
            variable: string;
            forms: { other: string; one?: string };
          }
        | undefined;
    };
    refreshOnInitialize?: boolean;
  } = {},
) {
  return createClient({
    baseUrl: 'https://ota.example/',
    token: 'gl_sdk_public_reference_token_abcdefghijklmnopqrstuvwxyz',
    projectId: fixture.projectId,
    environment: fixture.environment,
    locale: options.locale ?? 'en',
    transport,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.bundled ? { bundled: options.bundled } : {}),
    ...(options.refreshOnInitialize === undefined
      ? {}
      : {
          refreshPolicy: { refreshOnInitialize: options.refreshOnInitialize },
        }),
  });
}

describe('JavaScript reference SDK and OTA protocol v1', () => {
  it('formats plurals identically from OTA and bundled fallback', async () => {
    const plural = {
      type: 'plural' as const,
      variable: 'count',
      forms: { one: 'One item', other: '{count} items for {0}' },
    };
    const transport = new QueueTransport();
    const published = release(1, 'en', plural);
    transport.enqueue(published.manifestResponse, published.artifactResponse);
    const ota = client(transport);
    await ota.initialize();
    expect(
      ota.t(fixture.key, {
        namespace: fixture.namespace,
        count: 4,
        arguments: ['Sam'],
      }),
    ).toBe('4 items for Sam');

    const bundled = client(new QueueTransport(), {
      refreshOnInitialize: false,
      bundled: { get: () => plural },
    });
    await bundled.initialize();
    expect(bundled.t('items', { count: 1 })).toBe('One item');
    expect(bundled.t('items', { count: 3, arguments: ['Sam'] })).toBe(
      '3 items for Sam',
    );
  });

  it('initializes asynchronously while lookup stays synchronous and switches locale', async () => {
    const transport = new QueueTransport();
    const english = release(1, 'en', fixture.englishA);
    const arabic = release(1, 'ar', fixture.arabicA);
    transport.enqueue(
      english.manifestResponse,
      english.artifactResponse,
      arabic.manifestResponse,
      arabic.artifactResponse,
    );
    const sdk = client(transport, {
      bundled: {
        get: (_locale, namespace, key) =>
          namespace === 'common' && key === 'bundled'
            ? 'Bundled value'
            : undefined,
      },
    });
    await expect(sdk.initialize()).resolves.toEqual({
      status: 'updated',
      release: 1,
    });
    expect(sdk.t(fixture.key, { namespace: fixture.namespace })).toBe(
      fixture.englishA,
    );
    expect(sdk.namespaces()).toEqual([fixture.namespace]);
    expect(sdk.keys(fixture.namespace)).toEqual([fixture.key]);
    expect(sdk.translations()).toEqual([
      {
        key: fixture.key,
        namespace: fixture.namespace,
        value: fixture.englishA,
      },
    ]);
    expect(
      sdk.lookup(fixture.key, { namespace: fixture.namespace }),
    ).toMatchObject({
      value: fixture.englishA,
      source: 'ota',
      release: 1,
    });
    expect(sdk.t('bundled', { namespace: 'common' })).toBe('Bundled value');
    expect(sdk.t('missing', { fallback: 'Caller fallback' })).toBe(
      'Caller fallback',
    );
    expect(sdk.t('missing')).toBe('missing');
    await expect(sdk.setLocale('ar')).resolves.toMatchObject({
      status: 'updated',
    });
    expect(sdk.currentLocale).toBe('ar');
    expect(sdk.t(fixture.key, { namespace: fixture.namespace })).toBe(
      fixture.arabicA,
    );
    expect(
      transport.requests.every(({ headers }) =>
        headers.Authorization.startsWith('Bearer gl_sdk_'),
      ),
    ).toBe(true);
  });

  it('loads persistent last-known-good cache and survives offline refresh', async () => {
    const cache = new MemoryCacheAdapter();
    const online = new QueueTransport();
    const first = release(1, 'en', fixture.englishA);
    online.enqueue(first.manifestResponse, first.artifactResponse);
    await client(online, { cache }).initialize();

    const offline = new QueueTransport();
    offline.enqueue(new Error('network unavailable'));
    const restarted = client(offline, { cache });
    await expect(restarted.initialize()).resolves.toMatchObject({
      status: 'failed',
    });
    expect(restarted.currentRelease).toBe(1);
    expect(restarted.t(fixture.key, { namespace: fixture.namespace })).toBe(
      fixture.englishA,
    );
  });

  it('preserves bundled fallback on timeout without network-dependent lookup', async () => {
    const transport = new QueueTransport();
    transport.enqueue(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const sdk = client(transport, {
      timeoutMs: 5,
      bundled: { get: () => fixture.englishA },
    });
    await expect(sdk.initialize()).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/timed out/u),
    });
    expect(sdk.t(fixture.key, { namespace: fixture.namespace })).toBe(
      fixture.englishA,
    );
  });

  it.each([401, 403, 404, 429, 500])(
    'preserves last-known-good content on HTTP %s',
    async (status) => {
      const transport = new QueueTransport();
      const first = release(1, 'en', fixture.englishA);
      transport.enqueue(first.manifestResponse, first.artifactResponse);
      const sdk = client(transport);
      await sdk.initialize();
      transport.enqueue(response(status));
      await expect(sdk.refresh()).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringContaining(`HTTP ${status}`),
      });
      expect(sdk.currentRelease).toBe(1);
      expect(sdk.t(fixture.key, { namespace: fixture.namespace })).toBe(
        fixture.englishA,
      );
    },
  );

  it('rejects malformed/unsupported manifests and a missing locale', async () => {
    const cases = [
      response(200, '{'),
      response(
        200,
        JSON.stringify({
          protocolVersion: 2,
          projectId: fixture.projectId,
          environment: fixture.environment,
        }),
      ),
      response(
        200,
        JSON.stringify({
          protocolVersion: 1,
          projectId: fixture.projectId,
          environment: fixture.environment,
          release: 2,
          generatedAt: '2026-09-10T00:00:02.000Z',
          locales: {},
        }),
      ),
    ];
    for (const manifestResponse of cases) {
      const transport = new QueueTransport();
      transport.enqueue(manifestResponse);
      await expect(client(transport).refresh()).resolves.toMatchObject({
        status: 'failed',
      });
    }
  });

  it('requires secure origins and rejects cross-origin artifact token forwarding', async () => {
    expect(() =>
      createClient({
        baseUrl: 'http://ota.example/',
        token: 'gl_sdk_public_reference_token_abcdefghijklmnopqrstuvwxyz',
        projectId: fixture.projectId,
        environment: fixture.environment,
        locale: 'en',
      }),
    ).toThrow(/HTTPS/u);
    const transport = new QueueTransport();
    const first = release(1, 'en', fixture.englishA);
    transport.enqueue(
      response(
        200,
        JSON.stringify({
          ...first.manifest,
          locales: {
            en: {
              ...first.manifest.locales.en,
              url: 'https://attacker.example/artifact.json',
            },
          },
        }),
      ),
    );
    await expect(client(transport).refresh()).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Cross-origin'),
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('rejects malformed artifacts, scope mismatch, and hash mismatch', async () => {
    const invalidArtifacts = [
      {
        body: '{',
        adjustManifest: true,
        corruptResponse: false,
        expected: /malformed JSON/u,
      },
      {
        body: release(2, 'en', fixture.englishB, { projectId: 'other' })
          .artifactBody,
        adjustManifest: true,
        corruptResponse: false,
        expected: /scope mismatch/u,
      },
      {
        body: release(2, 'en', fixture.englishB).artifactBody,
        adjustManifest: false,
        corruptResponse: true,
        expected: /hash mismatch/u,
      },
    ];
    for (const invalid of invalidArtifacts) {
      const transport = new QueueTransport();
      const first = release(1, 'en', fixture.englishA);
      const second = release(2, 'en', fixture.englishB);
      const manifest = invalid.adjustManifest
        ? {
            ...second.manifest,
            locales: {
              en: {
                ...second.manifest.locales.en,
                hash: hash(invalid.body),
                size: new TextEncoder().encode(invalid.body).byteLength,
              },
            },
          }
        : second.manifest;
      transport.enqueue(
        first.manifestResponse,
        first.artifactResponse,
        response(200, JSON.stringify(manifest)),
        response(
          200,
          invalid.corruptResponse
            ? `${invalid.body.slice(0, -1)} `
            : invalid.body,
        ),
      );
      const sdk = client(transport);
      await sdk.initialize();
      await expect(sdk.refresh()).resolves.toMatchObject({
        status: 'failed',
        error: expect.stringMatching(invalid.expected),
      });
      expect(sdk.currentRelease).toBe(1);
      expect(sdk.t(fixture.key, { namespace: fixture.namespace })).toBe(
        fixture.englishA,
      );
    }
  });

  it('handles 304, same release, and a newer release without redundant replacement', async () => {
    const transport = new QueueTransport();
    const first = release(1, 'en', fixture.englishA);
    const second = release(2, 'en', fixture.englishB);
    transport.enqueue(first.manifestResponse, first.artifactResponse);
    const sdk = client(transport);
    await sdk.initialize();
    transport.enqueue(response(304));
    await expect(sdk.refresh()).resolves.toEqual({
      status: 'unchanged',
      release: 1,
    });
    transport.enqueue(first.manifestResponse);
    await expect(sdk.refresh()).resolves.toEqual({
      status: 'unchanged',
      release: 1,
    });
    transport.enqueue(second.manifestResponse, second.artifactResponse);
    await expect(sdk.refresh()).resolves.toEqual({
      status: 'updated',
      release: 2,
    });
    expect(sdk.t(fixture.key, { namespace: fixture.namespace })).toBe(
      fixture.englishB,
    );
    expect(
      transport.requests.some(({ headers }) =>
        Object.hasOwn(headers, 'If-None-Match'),
      ),
    ).toBe(true);
  });

  it('keeps memory and persistent last-known-good state on interrupted cache write', async () => {
    const cache = new InterruptibleCache();
    const transport = new QueueTransport();
    const first = release(1, 'en', fixture.englishA);
    const second = release(2, 'en', fixture.englishB);
    transport.enqueue(first.manifestResponse, first.artifactResponse);
    const sdk = client(transport, { cache });
    await sdk.initialize();
    cache.failWrites = true;
    transport.enqueue(second.manifestResponse, second.artifactResponse);
    await expect(sdk.refresh()).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('interrupted atomic cache write'),
    });
    expect(sdk.currentRelease).toBe(1);
    expect(sdk.t(fixture.key, { namespace: fixture.namespace })).toBe(
      fixture.englishA,
    );
    cache.failWrites = false;
    const restarted = client(new QueueTransport(), {
      cache,
      refreshOnInitialize: false,
    });
    await restarted.initialize();
    expect(restarted.currentRelease).toBe(1);
    expect(restarted.t(fixture.key, { namespace: fixture.namespace })).toBe(
      fixture.englishA,
    );
  });
});
