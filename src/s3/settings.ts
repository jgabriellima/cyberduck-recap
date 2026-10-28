/**
 * The settings `connect()` reads (design "Settings"): the selected profile, the region, the
 * endpoint and its source, from the options, an environment record and the shared files the SDK's
 * loader read. Pure: no I/O. Every value is checked with the rule of `validation.ts`, and a bad
 * one is INVALID_ARGUMENT that names its source, never its value.
 */
import type { RemoteFsError } from '../fs/errors.js';
import { escapeUnsafeText } from '../text/escape.js';
import { invalidArgument } from './errors.js';
import type { ValidatedS3Options } from './options.js';
import type { LoadedProfiles } from './transport.js';
import { endpointProblem, isRegion } from './validation.js';

export const DEFAULT_REGION = 'us-east-1';
export const DEFAULT_PROFILE = 'default';

export interface S3Settings {
  /** The profile the person selected (option, else `AWS_PROFILE`); `undefined`: none. */
  readonly selectedProfile: string | undefined;
  /** The profile whose settings apply: the selected one, else `default`. */
  readonly settingsProfile: string;
  readonly region: string;
  /** A custom endpoint's origin; `undefined`: AWS's endpoint for the region. */
  readonly endpoint: string | undefined;
  /** The host named in messages (a bucket that does not exist on it). */
  readonly endpointHost: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

function set(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** A profile's settings, the config file's before the credentials file's, as the SDK reads them. */
export function profileSettings(
  profiles: LoadedProfiles,
  name: string,
): Readonly<Record<string, string>> | undefined {
  const fromCredentials = profiles.credentials[name];
  const fromConfig = profiles.config[name];
  if (fromCredentials === undefined && fromConfig === undefined) {
    return undefined;
  }
  return { ...fromCredentials, ...fromConfig };
}

/** A profile as messages name it: escaped and cut, since the name comes from a file. */
export function profileLabel(name: string): string {
  return `profile ${escapeUnsafeText(name).slice(0, 128)}`;
}

function badEndpoint(source: string, why: string): RemoteFsError {
  return invalidArgument(`the endpoint of ${source} ${why}`);
}

export function resolveSettings(
  options: ValidatedS3Options,
  env: Environment,
  profiles: LoadedProfiles,
): S3Settings {
  const selectedProfile =
    options.profile ?? (set(env.AWS_PROFILE) ? env.AWS_PROFILE : undefined);
  const settingsProfile = selectedProfile ?? DEFAULT_PROFILE;
  const profile = profileSettings(profiles, settingsProfile) ?? {};

  let endpoint = options.endpoint;
  if (endpoint === undefined) {
    const sources: [string, string | undefined][] = [
      ['AWS_ENDPOINT_URL_S3', env.AWS_ENDPOINT_URL_S3],
      ['AWS_ENDPOINT_URL', env.AWS_ENDPOINT_URL],
      [`${profileLabel(settingsProfile)} endpoint_url`, profile.endpoint_url],
    ];
    const found = sources.find(([, value]) => set(value));
    if (found !== undefined) {
      const [source, value = ''] = found;
      const problem = endpointProblem(value);
      if (problem !== undefined) throw badEndpoint(source, problem);
      endpoint = new URL(value).origin;
    }
  }

  let region = options.region;
  if (region === undefined) {
    const sources: [string, string | undefined][] = [
      ['AWS_REGION', env.AWS_REGION],
      [`${profileLabel(settingsProfile)} region`, profile.region],
    ];
    const found = sources.find(([, value]) => set(value));
    if (found !== undefined) {
      const [source, value] = found;
      if (!isRegion(value)) {
        throw invalidArgument(
          `the region of ${source} must be a region name of lower-case letters, digits and -`,
        );
      }
      region = value;
    }
  }
  region ??= DEFAULT_REGION;

  return {
    selectedProfile,
    settingsProfile,
    region,
    endpoint,
    endpointHost: endpointHostOf(endpoint, region),
  };
}

/** The host requests go to: the custom endpoint's, else AWS's endpoint for `region`. */
export function endpointHostOf(
  endpoint: string | undefined,
  region: string,
): string {
  return endpoint === undefined
    ? `s3.${region}.amazonaws.com`
    : new URL(endpoint).host;
}
