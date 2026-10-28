import type { BackendDefinition, Endpoint } from '../fs/backend.js';
import { escapeUnsafeText } from '../text/escape.js';
import { invalidArgument } from './errors.js';
import { S3FileSystem } from './s3-file-system.js';
import { bucketProblem } from './validation.js';

/**
 * The S3 back-end as the registry knows it (FEATURE-3). `s3://<bucket>/<key>` makes a
 * bucket-scoped instance; `s3://`, `s3:///` and `s3:///<bucket>/<key>` an account-wide one. The
 * keys come from the AWS environment and shared files, so the CLI reads no password, key file or
 * known_hosts file for it.
 */
export const s3Backend: BackendDefinition = {
  create: (target) =>
    new S3FileSystem(target.host === '' ? {} : { bucket: target.host }),
  credential: 'none',
  usesKnownHosts: false,
  checkEndpoint: (endpoint: Endpoint) => {
    if (endpoint.username !== '') {
      throw invalidArgument(
        `the user name ${escapeUnsafeText(endpoint.username).slice(0, 128)} is not accepted in an s3 URL; the AWS keys come from the environment or the shared files`,
      );
    }
    if (endpoint.port !== undefined) {
      throw invalidArgument(
        `the port ${endpoint.port} is not accepted in an s3 URL; set the endpoint in AWS_ENDPOINT_URL_S3`,
      );
    }
    const problem =
      endpoint.host === '' ? undefined : bucketProblem(endpoint.host);
    if (problem !== undefined) {
      throw invalidArgument(`the bucket of the s3 URL ${problem}`);
    }
  },
};
