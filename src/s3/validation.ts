/**
 * The one source of each value rule of the S3 back-end (design Decision 12): the option, every
 * settings source, a server's redirect header and a path all pass the same function, and each
 * caller only adds the message that names its source. Pure: no I/O, no import.
 */

/** A region becomes a label of a host name, so it is held to one DNS label. */
export const REGION_PATTERN = /^[a-z0-9-]{1,63}$/;

export function isRegion(value: unknown): value is string {
  return typeof value === 'string' && REGION_PATTERN.test(value);
}

/** Why an endpoint is refused, in words the caller puts after the name of its source. */
export type EndpointProblem =
  | 'is not a URL'
  | 'must use https:'
  | 'must not hold a user name or password'
  | 'must not have a query or a fragment'
  | 'must not have a path';

/**
 * `undefined` when `value` is an `https:` URL with no user information, query, fragment or
 * path.
 */
export function endpointProblem(value: string): EndpointProblem | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not a URL';
  }
  // The user information is checked first: it can hold a password, which the URL must not carry
  // to any request, whatever its scheme.
  if (url.username !== '' || url.password !== '') {
    return 'must not hold a user name or password';
  }
  if (url.protocol !== 'https:') return 'must use https:';
  if (url.search !== '' || url.hash !== '' || /[?#]/.test(value)) {
    return 'must not have a query or a fragment';
  }
  if (url.pathname !== '/' && url.pathname !== '')
    return 'must not have a path';
  return undefined;
}

export type BucketProblem =
  'must not be empty' | "must not hold '/'" | "must not start with 'arn:'";

/**
 * `undefined` for a usable bucket name. An ARN is refused because the SDK reads it as an access
 * point and derives another host from it.
 */
export function bucketProblem(value: string): BucketProblem | undefined {
  if (value === '') return 'must not be empty';
  if (value.includes('/')) return "must not hold '/'";
  if (value.toLowerCase().startsWith('arn:'))
    return "must not start with 'arn:'";
  return undefined;
}

/**
 * Whether a bucket on AWS's own endpoint goes in the host name (virtual-hosted style, spec
 * "Custom endpoint"): a name that is one DNS label. The SDK sends a bucket of fewer than 3
 * characters path-style; such a name is sent virtual-hosted all the same. A name with `.` stays
 * path-style: the wildcard certificate of `*.s3.<region>.amazonaws.com` covers one label only.
 */
export function isVirtualHostable(bucket: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(bucket);
}

export const MAX_UPLOAD_ID_LENGTH = 1024;

/** A server's upload ID: a string of 1 to 1,024 UTF-16 units. Its characters are not limited. */
export function isUploadId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_UPLOAD_ID_LENGTH
  );
}

/**
 * The characters a value may hold to be printed inside single quotes in a remedy command: none of
 * them is special to sh, PowerShell or cmd.exe there.
 */
export const COMMAND_SAFE = /^[A-Za-z0-9 ._\-/:=+@,~]+$/;
