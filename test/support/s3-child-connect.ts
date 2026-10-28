/**
 * Run in a child process by `runChildConnect` (test/support/s3.ts): connects one S3 instance
 * built from the JSON in `S3_CHILD_OPTIONS` and prints `connected`, or `error <CODE>` and the
 * message. Node reads `NODE_EXTRA_CA_CERTS` only when a process starts, so AC-26 needs this.
 */
const specifier = '../../src/s3/s3-file-system.js';

interface Instance {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

async function main(): Promise<void> {
  const module = (await import(specifier)) as {
    S3FileSystem: new (options: unknown) => Instance;
  };
  const options: unknown = JSON.parse(process.env.S3_CHILD_OPTIONS ?? '{}');
  const fs = new module.S3FileSystem(options);
  try {
    await fs.connect();
    process.stdout.write('connected\n');
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    process.stdout.write(`error ${String(code)} ${String(message)}\n`);
    process.exitCode = 1;
  } finally {
    await fs.disconnect().catch(() => undefined);
  }
}

await main();
