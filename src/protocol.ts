export const OTA_PROTOCOL_VERSION = 1 as const;

export interface OtaManifestLocale {
  readonly hash: string;
  readonly url: string;
  readonly size: number;
}

export interface OtaManifest {
  readonly protocolVersion: typeof OTA_PROTOCOL_VERSION;
  readonly projectId: string;
  readonly environment: string;
  readonly release: number;
  readonly generatedAt: string;
  readonly locales: Readonly<Record<string, OtaManifestLocale>>;
}

export interface OtaArtifact {
  readonly protocolVersion: typeof OTA_PROTOCOL_VERSION;
  readonly projectId: string;
  readonly environment: string;
  readonly release: number;
  readonly locale: string;
  readonly namespaces: Readonly<
    Record<string, Readonly<Record<string, OtaMessage>>>
  >;
}

export const OTA_PLURAL_CATEGORIES = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
] as const;

export type OtaPluralCategory = (typeof OTA_PLURAL_CATEGORIES)[number];

export interface OtaPluralMessage {
  readonly type: 'plural';
  readonly variable: string;
  readonly forms: Readonly<
    Partial<Record<OtaPluralCategory, string>> & { readonly other: string }
  >;
}

export type OtaMessage = string | OtaPluralMessage;

export class OtaProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtaProtocolError';
  }
}

export function parseOtaManifest(input: unknown): OtaManifest {
  const value = record(input, 'manifest');
  protocol(value.protocolVersion);
  const localesInput = record(value.locales, 'manifest.locales');
  const locales: Record<string, OtaManifestLocale> = {};
  for (const [locale, entryInput] of Object.entries(localesInput)) {
    if (!locale) fail('manifest locale must not be empty');
    const entry = record(entryInput, `manifest.locales.${locale}`);
    const hash = text(entry.hash, `manifest.locales.${locale}.hash`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(hash)) {
      fail(`manifest.locales.${locale}.hash must be SHA-256`);
    }
    locales[locale] = {
      hash,
      url: text(entry.url, `manifest.locales.${locale}.url`),
      size: integer(entry.size, `manifest.locales.${locale}.size`, 0),
    };
  }
  return {
    protocolVersion: OTA_PROTOCOL_VERSION,
    projectId: text(value.projectId, 'manifest.projectId'),
    environment: text(value.environment, 'manifest.environment'),
    release: integer(value.release, 'manifest.release', 1),
    generatedAt: timestamp(value.generatedAt, 'manifest.generatedAt'),
    locales,
  };
}

export function parseOtaArtifact(input: unknown): OtaArtifact {
  const value = record(input, 'artifact');
  protocol(value.protocolVersion);
  const namespacesInput = record(value.namespaces, 'artifact.namespaces');
  const namespaces: Record<string, Record<string, OtaMessage>> = {};
  for (const [namespace, entriesInput] of Object.entries(namespacesInput)) {
    if (!namespace) fail('artifact namespace must not be empty');
    const entries = record(entriesInput, `artifact.namespaces.${namespace}`);
    namespaces[namespace] = Object.fromEntries(
      Object.entries(entries).map(([key, translation]) => {
        if (!key) fail('artifact translation key must not be empty');
        return [key, message(translation, `artifact translation ${key}`)];
      }),
    );
  }
  return {
    protocolVersion: OTA_PROTOCOL_VERSION,
    projectId: text(value.projectId, 'artifact.projectId'),
    environment: text(value.environment, 'artifact.environment'),
    release: integer(value.release, 'artifact.release', 1),
    locale: text(value.locale, 'artifact.locale'),
    namespaces,
  };
}

function message(input: unknown, field: string): OtaMessage {
  if (typeof input === 'string') return text(input, field);
  const value = record(input, field);
  if (value.type !== 'plural') fail(`${field}.type must be plural`);
  const variable = text(value.variable, `${field}.variable`);
  if (!/^[\p{L}_][\p{L}\p{M}\p{Nd}_.-]*$/u.test(variable)) {
    fail(`${field}.variable is invalid`);
  }
  const formsInput = record(value.forms, `${field}.forms`);
  const forms: Partial<Record<OtaPluralCategory, string>> = {};
  for (const [category, form] of Object.entries(formsInput)) {
    if (!(OTA_PLURAL_CATEGORIES as readonly string[]).includes(category)) {
      fail(`${field}.forms.${category} is not a plural category`);
    }
    forms[category as OtaPluralCategory] = text(
      form,
      `${field}.forms.${category}`,
    );
  }
  if (!forms.other) fail(`${field}.forms.other is required`);
  return {
    type: 'plural',
    variable,
    forms: forms as OtaPluralMessage['forms'],
  };
}

function protocol(input: unknown): void {
  if (input !== OTA_PROTOCOL_VERSION) {
    fail(`unsupported OTA protocol version: ${String(input)}`);
  }
}

function record(input: unknown, field: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(`${field} must be an object`);
  }
  return input as Record<string, unknown>;
}

function text(input: unknown, field: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return input;
}

function integer(input: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(input) || (input as number) < minimum) {
    fail(`${field} must be an integer greater than or equal to ${minimum}`);
  }
  return input as number;
}

function timestamp(input: unknown, field: string): string {
  const value = text(input, field);
  if (Number.isNaN(Date.parse(value)))
    fail(`${field} must be an ISO timestamp`);
  return value;
}

function fail(message: string): never {
  throw new OtaProtocolError(message);
}
