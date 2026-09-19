# GoLocalise JavaScript SDK

Official JavaScript/TypeScript SDK for GoLocalise.

GoLocalise lets applications fetch versioned translations over the air (OTA), switch locales at runtime, and continue working from cached or bundled translations when the network is unavailable.

## Features

- OTA translation updates
- Versioned releases
- Runtime locale switching
- Synchronous translation lookup
- Offline last-known-good cache
- Namespace support
- Pluralization
- Placeholder formatting
- SHA-256 artifact verification
- Same-origin protection
- TypeScript support

## Installation

```bash
npm install @golocalise/javascript-sdk
```

The npm package will become available when the first public release is published.

## Quick Start

```ts
import {
  createClient,
  MemoryCacheAdapter,
} from '@golocalise/javascript-sdk';

const client = createClient({
  baseUrl: 'https://api.golocalise.me',
  token: 'gl_sdk_your_public_read_token',
  projectId: 'your-project-id',
  environment: 'production',
  locale: 'en',
  cache: new MemoryCacheAdapter(),
});

await client.initialize();

const title = client.translation(
  'welcome',
  'common',
  'Welcome',
);
```

## Switching Locale

```ts
await client.setLocale('ar');

const title = client.translation(
  'welcome',
  'common',
  'Welcome',
);
```

## OTA and Offline Behavior

GoLocalise validates OTA manifests and translation artifacts before replacing cached translations.

The SDK verifies project and environment scope, protocol version, artifact origin, artifact size, and SHA-256 checksum.

If an update fails, the existing last-known-good translations remain available. Translation lookup itself does not perform network requests.

## Requirements

- Modern browsers with Fetch API support
- Modern Node.js runtimes with Fetch API support
- TypeScript declarations are included

## Security

Use a GoLocalise public SDK credential beginning with `gl_sdk_`.

Public SDK credentials are designed for client applications. Never embed administrative or private server credentials in browser or mobile applications.

## Documentation

Visit https://golocalise.me for more information.

## Status

This SDK implements GoLocalise OTA protocol v1.
