/**
 * An in-process SSH/SFTP server for the integration tests (decision 4A): real SSH and SFTP over a
 * real TCP socket on 127.0.0.1, serving a temporary directory, with server-side counters and fault
 * injection. Its errno-to-status mapping follows OpenSSH's sftp-server behaviour (studied, not
 * copied): ENOENT is NO_SUCH_FILE, EACCES/EPERM PERMISSION_DENIED, everything else FAILURE.
 */
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, posix, resolve, sep } from 'node:path';
import ssh2 from 'ssh2';
import type { AuthContext, Connection, SFTPWrapper } from 'ssh2';

const { Server, utils } = ssh2;
const STATUS = utils.sftp.STATUS_CODE;

export interface KeyPair {
  /** OpenSSH private key text, generated at test time: no key material is ever committed. */
  readonly privateKey: string;
  /** `<type> <base64>` public key line. */
  readonly publicKey: string;
  readonly blob: Buffer;
  readonly type: string;
  readonly fingerprint: string;
}

function generatePair(passphrase?: string): {
  private: string;
  public: string;
} {
  return passphrase === undefined
    ? utils.generateKeyPairSync('ed25519')
    : // One bcrypt round: the key format is the same as with OpenSSH's 16, and these keys are
      // throwaway test material, so the extra seconds of pure-JS bcrypt buy nothing but timeouts.
      utils.generateKeyPairSync('ed25519', {
        passphrase,
        cipher: 'aes256-ctr',
        rounds: 1,
      });
}

// ssh2's generator drops a leading zero byte of an Ed25519 key about once in 200 keys, and its own
// parser then rejects the key; regenerating keeps the tests from failing on that at random.
function generateParseablePair(passphrase?: string): {
  private: string;
  public: string;
} {
  for (;;) {
    const pair = generatePair(passphrase);
    if (
      !(utils.parseKey(pair.private, passphrase) instanceof Error) &&
      !(utils.parseKey(pair.public) instanceof Error)
    ) {
      return pair;
    }
  }
}

export function generateKey(passphrase?: string): KeyPair {
  const pair = generateParseablePair(passphrase);
  const [type = '', base64 = ''] = pair.public.split(' ');
  const blob = Buffer.from(base64, 'base64');
  const digest = createHash('sha256').update(blob).digest('base64');
  return {
    privateKey: pair.private,
    publicKey: `${type} ${base64}`,
    blob,
    type,
    fingerprint: `SHA256:${digest.replace(/=+$/, '')}`,
  };
}

export interface SftpServerOptions {
  readonly password?: string;
  readonly authorizedKeys?: readonly KeyPair[];
  readonly hostKey?: KeyPair;
}

export interface SftpServerStats {
  /** TCP connections accepted. */
  connections: number;
  /** USERAUTH requests of any method. */
  authAttempts: number;
  /** Connections that authenticated. */
  sessions: number;
  /** File bytes served by READ and accepted by WRITE. */
  bytesTransferred: number;
  /** SFTP requests received, answered or not. */
  requests: number;
  /** SFTP requests received, by type (`READ`, `REALPATH`, …), so a test can tell traffic apart. */
  requestsByType: Record<string, number>;
}

export interface SftpServerFixture {
  readonly host: '127.0.0.1';
  readonly port: number;
  /** Local directory served as the remote `/`. */
  readonly root: string;
  readonly hostKey: KeyPair;
  readonly stats: SftpServerStats;
  /** `[127.0.0.1]:<port> <type> <base64>`: the known_hosts line trusting this server. */
  readonly knownHostsLine: string;
  /** Answers PERMISSION_DENIED for every request that names this remote path. */
  deny(path: string): void;
  /** Destroys every socket once more than `bytes` file bytes have been transferred. */
  dropAfterBytes(bytes: number): void;
  /** Destroys every open socket now. */
  dropAll(): void;
  /** Stops answering SFTP requests (the socket stays up). */
  stall(): void;
  /** Answers SFTP requests again (those received while stalled stay unanswered). */
  resume(): void;
  /** The next READDIR returns these names instead of the directory's. */
  hostileNames(names: readonly string[]): void;
  /** Every failure status carries this text. */
  hostileStatusText(text: string): void;
  /** READ answers with zero bytes and no end of file. */
  zeroLengthReads(): void;
  /** Resolves when `predicate` holds, polling the fixture's state. */
  waitUntil(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** Local path of a remote path. */
  local(path: string): string;
  close(): Promise<void>;
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('condition not reached in time');
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 5));
  }
}

type HandleState =
  | { kind: 'file'; path: string; file: FileHandle }
  | { kind: 'dir'; path: string; done: boolean };

function attrsOf(stats: import('node:fs').Stats) {
  return {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

export async function startSftpServer(
  options: SftpServerOptions = {},
): Promise<SftpServerFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sftp-fixture-')));
  const hostKey = options.hostKey ?? generateKey();
  const authorized = (options.authorizedKeys ?? []).map((key) => {
    const parsed = utils.parseKey(key.publicKey);
    if (parsed instanceof Error) throw parsed;
    return parsed;
  });
  const stats: SftpServerStats = {
    connections: 0,
    authAttempts: 0,
    sessions: 0,
    bytesTransferred: 0,
    requests: 0,
    requestsByType: {},
  };
  const sockets = new Set<Socket>();
  const denied = new Set<string>();
  let dropAfter: number | undefined;
  let stalled = false;
  let nextNames: readonly string[] | undefined;
  let statusText: string | undefined;
  let zeroReads = false;

  const normalize = (path: string): string =>
    posix.normalize(path.startsWith('/') ? path : `/${path}`);
  const local = (path: string): string => {
    const target = resolve(root, `.${normalize(path)}`);
    if (target !== root && !target.startsWith(root + sep)) {
      throw Object.assign(new Error('outside the root'), { code: 'EACCES' });
    }
    return target;
  };
  const dropAll = (): void => {
    for (const socket of sockets) socket.destroy();
  };
  const countBytes = (bytes: number): boolean => {
    stats.bytesTransferred += bytes;
    if (dropAfter !== undefined && stats.bytesTransferred > dropAfter) {
      dropAll();
      return true;
    }
    return false;
  };

  const sshServer = new Server(
    { hostKeys: [hostKey.privateKey] },
    (client: Connection) => {
      client.on('error', () => undefined);
      client.on('authentication', (context: AuthContext) => {
        stats.authAttempts += 1;
        if (
          context.method === 'password' &&
          options.password !== undefined &&
          context.password === options.password
        ) {
          context.accept();
          return;
        }
        if (context.method === 'publickey') {
          const key = authorized.find(
            (candidate) =>
              candidate.type === context.key.algo &&
              candidate.getPublicSSH().equals(context.key.data),
          );
          if (key !== undefined) {
            if (context.signature === undefined || context.blob === undefined) {
              context.accept();
              return;
            }
            if (key.verify(context.blob, context.signature, context.hashAlgo)) {
              context.accept();
              return;
            }
          }
        }
        context.reject(['password', 'publickey']);
      });
      client.on('ready', () => {
        stats.sessions += 1;
        client.on('session', (acceptSession) => {
          const session = acceptSession();
          session.on('sftp', (acceptSftp) => {
            serve(acceptSftp());
          });
        });
      });
    },
  );

  function serve(sftp: SFTPWrapper): void {
    const handles = new Map<number, HandleState>();
    let nextHandle = 1;
    const newHandle = (state: HandleState): Buffer => {
      const id = nextHandle++;
      handles.set(id, state);
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(id);
      return buffer;
    };
    // A dropped connection leaves handles open; close them so no descriptor outlives the test.
    const closeAll = (): void => {
      for (const state of handles.values()) {
        if (state.kind === 'file')
          void state.file.close().catch(() => undefined);
      }
      handles.clear();
    };
    sftp.on('close', closeAll);
    sftp.on('end', closeAll);
    const handleOf = (buffer: Buffer): HandleState | undefined =>
      buffer.length === 4 ? handles.get(buffer.readUInt32BE(0)) : undefined;

    const status = (
      id: number,
      code: (typeof STATUS)[keyof typeof STATUS],
      text: string,
    ): void => {
      const message =
        code === STATUS.OK || code === STATUS.EOF ? text : (statusText ?? text);
      sftp.status(id, code, message);
    };
    const fail = (id: number, error: unknown): void => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') status(id, STATUS.NO_SUCH_FILE, 'No such file');
      else if (code === 'EACCES' || code === 'EPERM') {
        status(id, STATUS.PERMISSION_DENIED, 'Permission denied');
      } else status(id, STATUS.FAILURE, 'Failure');
    };
    const isDenied = (...paths: string[]): boolean =>
      paths.some((path) => denied.has(normalize(path)));

    // Every request runs through here: a stalled server drops it, a denied path is refused.
    const on = (
      event: string,
      paths: (...args: never[]) => string[],
      run: (id: number, ...args: never[]) => Promise<void>,
    ): void => {
      sftp.on(event, (id: number, ...args: never[]) => {
        stats.requests += 1;
        stats.requestsByType[event] = (stats.requestsByType[event] ?? 0) + 1;
        if (stalled) return;
        if (isDenied(...paths(...args))) {
          status(id, STATUS.PERMISSION_DENIED, 'Permission denied');
          return;
        }
        run(id, ...args).catch((error: unknown) => {
          if (!stalled) fail(id, error);
        });
      });
    };
    const handlePath = (handle: Buffer): string[] => {
      const state = handleOf(handle);
      return state === undefined ? [] : [state.path];
    };

    on(
      'OPEN',
      (path: string) => [path],
      async (id, path: string, flags: number) => {
        const mode = utils.sftp.flagsToString(flags) ?? 'r';
        const file = await open(local(path), mode, 0o644);
        sftp.handle(id, newHandle({ kind: 'file', path, file }));
      },
    );
    on(
      'READ',
      handlePath,
      async (id, handle: Buffer, offset: number, length: number) => {
        const state = handleOf(handle);
        if (state?.kind !== 'file') throw new Error('bad handle');
        if (zeroReads) {
          sftp.data(id, Buffer.alloc(0));
          return;
        }
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await state.file.read(buffer, 0, length, offset);
        if (bytesRead === 0) {
          status(id, STATUS.EOF, 'EOF');
          return;
        }
        if (countBytes(bytesRead)) return;
        sftp.data(id, buffer.subarray(0, bytesRead));
      },
    );
    on(
      'WRITE',
      handlePath,
      async (id, handle: Buffer, offset: number, data: Buffer) => {
        const state = handleOf(handle);
        if (state?.kind !== 'file') throw new Error('bad handle');
        await state.file.write(data, 0, data.length, offset);
        if (countBytes(data.length)) return;
        status(id, STATUS.OK, 'OK');
      },
    );
    on('FSTAT', handlePath, async (id, handle: Buffer) => {
      const state = handleOf(handle);
      if (state?.kind !== 'file') throw new Error('bad handle');
      sftp.attrs(id, attrsOf(await state.file.stat()));
    });
    on('CLOSE', handlePath, async (id, handle: Buffer) => {
      const state = handleOf(handle);
      if (state === undefined) throw new Error('bad handle');
      handles.delete(handle.readUInt32BE(0));
      if (state.kind === 'file') await state.file.close();
      status(id, STATUS.OK, 'OK');
    });
    on(
      'OPENDIR',
      (path: string) => [path],
      async (id, path: string) => {
        const stats = await fs.stat(local(path));
        if (!stats.isDirectory()) {
          throw Object.assign(new Error('not a directory'), {
            code: 'ENOTDIR',
          });
        }
        sftp.handle(id, newHandle({ kind: 'dir', path, done: false }));
      },
    );
    on('READDIR', handlePath, async (id, handle: Buffer) => {
      const state = handleOf(handle);
      if (state?.kind !== 'dir') throw new Error('bad handle');
      if (state.done) {
        status(id, STATUS.EOF, 'EOF');
        return;
      }
      state.done = true;
      const directory = local(state.path);
      const own = await fs.lstat(directory);
      const names =
        nextNames ?? (await readdir(directory)).filter((name) => name !== '');
      const hostile = nextNames !== undefined;
      nextNames = undefined;
      const entries = [
        { filename: '.', longname: '.', attrs: attrsOf(own) },
        { filename: '..', longname: '..', attrs: attrsOf(own) },
      ];
      for (const name of names) {
        const attrs = hostile
          ? attrsOf(own)
          : attrsOf(await fs.lstat(join(directory, name)));
        entries.push({ filename: name, longname: name, attrs });
      }
      sftp.name(id, entries);
    });
    on(
      'STAT',
      (path: string) => [path],
      async (id, path: string) => {
        sftp.attrs(id, attrsOf(await fs.stat(local(path))));
      },
    );
    on(
      'LSTAT',
      (path: string) => [path],
      async (id, path: string) => {
        sftp.attrs(id, attrsOf(await fs.lstat(local(path))));
      },
    );
    on(
      'MKDIR',
      (path: string) => [path],
      async (id, path: string) => {
        await fs.mkdir(local(path));
        status(id, STATUS.OK, 'OK');
      },
    );
    on(
      'RMDIR',
      (path: string) => [path],
      async (id, path: string) => {
        await fs.rmdir(local(path));
        status(id, STATUS.OK, 'OK');
      },
    );
    on(
      'REMOVE',
      (path: string) => [path],
      async (id, path: string) => {
        await fs.unlink(local(path));
        status(id, STATUS.OK, 'OK');
      },
    );
    on(
      'RENAME',
      (from: string, to: string) => [from, to],
      async (id, from: string, to: string) => {
        // OpenSSH's RENAME links then unlinks, so it never replaces an existing target.
        const target = local(to);
        const exists = await fs.lstat(target).then(
          () => true,
          () => false,
        );
        if (exists) {
          throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        }
        await fs.rename(local(from), target);
        status(id, STATUS.OK, 'OK');
      },
    );
    on(
      'REALPATH',
      (path: string) => [path],
      async (id, path: string) => {
        const name = normalize(path);
        sftp.name(id, [{ filename: name, longname: name, attrs: {} as never }]);
        return Promise.resolve();
      },
    );
    for (const event of ['SETSTAT', 'FSETSTAT']) {
      on(
        event,
        () => [],
        async (id) => {
          status(id, STATUS.OK, 'OK');
          return Promise.resolve();
        },
      );
    }
    on(
      'EXTENDED',
      () => [],
      async (id) => {
        status(id, STATUS.OP_UNSUPPORTED, 'Unsupported');
        return Promise.resolve();
      },
    );
  }

  const netServer: NetServer = createServer((socket) => {
    stats.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    sshServer.injectSocket(socket);
  });
  await new Promise<void>((resolveListen) =>
    netServer.listen(0, '127.0.0.1', resolveListen),
  );
  const address = netServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture did not get a TCP port');
  }
  const port = address.port;

  return {
    host: '127.0.0.1',
    port,
    root,
    hostKey,
    stats,
    knownHostsLine: `[127.0.0.1]:${port} ${hostKey.publicKey}`,
    deny: (path) => denied.add(normalize(path)),
    dropAfterBytes: (bytes) => {
      dropAfter = stats.bytesTransferred + bytes;
    },
    dropAll,
    stall: () => {
      stalled = true;
    },
    resume: () => {
      stalled = false;
    },
    hostileNames: (names) => {
      nextNames = names;
    },
    hostileStatusText: (text) => {
      statusText = text;
    },
    zeroLengthReads: () => {
      zeroReads = true;
    },
    waitUntil,
    local,
    close: async () => {
      dropAll();
      await new Promise<void>((resolveClose) =>
        netServer.close(() => resolveClose()),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface SilentServer {
  readonly port: number;
  readonly connections: () => number;
  close(): Promise<void>;
}

/** Accepts TCP and never sends an SSH banner: the handshake can only time out. */
export async function startSilentServer(): Promise<SilentServer> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('silent server did not get a TCP port');
  }
  return {
    port: address.port,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
    },
  };
}

/** A port nothing listens on: bound once by us, then released. */
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (address === null || typeof address === 'string') {
    throw new Error('could not reserve a port');
  }
  return address.port;
}
