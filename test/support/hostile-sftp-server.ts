/**
 * A hostile SSH/SFTP server for the adversarial tests: real SSH over a real TCP socket on
 * 127.0.0.1, where each test scripts the SFTP replies itself (out-of-order, spurious, endless,
 * malformed attributes, a channel that closes mid-transfer) and can make the server present a host
 * key it cannot prove it holds. It lives in test/support because only src/sftp and test/support
 * may import ssh2 (G-7); the tests reach ssh2 only through the types re-exported here.
 */
import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import ssh2 from 'ssh2';
import type { AuthContext, Connection, ParsedKey, SFTPWrapper } from 'ssh2';
import { generateKey, type KeyPair } from './sftp-server.js';

const { Server, utils } = ssh2;

/** The server side of one SFTP channel, as ssh2 gives it to the script. */
export type HostileSftp = SFTPWrapper;

export const STATUS = utils.sftp.STATUS_CODE;

/** Builds a `KeyPair` of any type ssh2 can generate; keys are made at test time, never committed. */
export function generateKeyOfType(type: 'ecdsa' | 'rsa'): KeyPair {
  const pair =
    type === 'ecdsa'
      ? utils.generateKeyPairSync('ecdsa', { bits: 256 })
      : utils.generateKeyPairSync('rsa', { bits: 2048 });
  const [keyType = '', base64 = ''] = pair.public.split(' ');
  const blob = Buffer.from(base64, 'base64');
  const digest = createHash('sha256').update(blob).digest('base64');
  return {
    privateKey: pair.private,
    publicKey: `${keyType} ${base64}`,
    blob,
    type: keyType,
    fingerprint: `SHA256:${digest.replace(/=+$/, '')}`,
  };
}

export interface HostileServerOptions {
  readonly password: string;
  readonly hostKey?: KeyPair;
  /**
   * The server presents `hostKey` but signs the key exchange with another key of the same type:
   * a man-in-the-middle that shows a victim's public key without holding its private half.
   */
  readonly forgeHostKeySignature?: boolean;
  /** Scripts the SFTP subsystem; without it the server opens no SFTP channel. */
  readonly serve?: (sftp: HostileSftp) => void;
  /**
   * Refuses the session channel with this description: CHANNEL_OPEN_FAILURE carries server-chosen
   * text that ssh2 copies into the client's error message.
   */
  readonly refuseSessionWith?: string;
}

export interface HostileServerStats {
  connections: number;
  authAttempts: number;
  sessions: number;
}

export interface HostileServer {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly hostKey: KeyPair;
  readonly stats: HostileServerStats;
  readonly knownHostsLine: string;
  /** TCP connections still open: an abandoned session that was never closed shows up here. */
  liveConnections(): number;
  close(): Promise<void>;
}

type Signer = (this: ParsedKey, data: Buffer, algo?: string) => Buffer | Error;

/**
 * Swaps the shared `sign` of the host key's class for one that signs with an impostor key when the
 * key is this server's host key; returns the function that restores it.
 */
function forgeSignatures(hostKey: KeyPair): () => void {
  const parsed = utils.parseKey(hostKey.privateKey);
  const impostor = utils.parseKey(
    hostKey.type === 'ssh-ed25519'
      ? generateKey().privateKey
      : generateKeyOfType(hostKey.type === 'ssh-rsa' ? 'rsa' : 'ecdsa')
          .privateKey,
  );
  if (parsed instanceof Error || impostor instanceof Error) {
    throw new Error('could not parse the keys to forge');
  }
  const proto = Object.getPrototypeOf(parsed) as { sign: Signer };
  const original = proto.sign;
  proto.sign = function sign(this: ParsedKey, data, algo) {
    return this.getPublicSSH().equals(hostKey.blob)
      ? original.call(impostor, data, algo)
      : original.call(this, data, algo);
  };
  return () => {
    proto.sign = original;
  };
}

type ChannelOpenFail = (remote: number, reason: number, desc?: string) => void;

/**
 * ssh2's own reject() sends no description, so the server's protocol writer is wrapped for this one
 * reply: the description is the hostile text under test.
 */
function refuseWithText(
  client: Connection,
  reject: () => void,
  description: string,
): void {
  const protocol = (
    client as unknown as { _protocol: { channelOpenFail: ChannelOpenFail } }
  )._protocol;
  const original = protocol.channelOpenFail;
  protocol.channelOpenFail = (remote, reason) =>
    original.call(protocol, remote, reason, description);
  try {
    reject();
  } finally {
    protocol.channelOpenFail = original;
  }
}

export async function startHostileServer(
  options: HostileServerOptions,
): Promise<HostileServer> {
  const hostKey = options.hostKey ?? generateKey();
  const stats: HostileServerStats = {
    connections: 0,
    authAttempts: 0,
    sessions: 0,
  };
  const restore = options.forgeHostKeySignature
    ? forgeSignatures(hostKey)
    : () => undefined;
  const sockets = new Set<Socket>();

  const sshServer = new Server(
    { hostKeys: [hostKey.privateKey] },
    (client: Connection) => {
      client.on('error', () => undefined);
      client.on('authentication', (context: AuthContext) => {
        stats.authAttempts += 1;
        if (
          context.method === 'password' &&
          context.password === options.password
        ) {
          context.accept();
          return;
        }
        context.reject(['password']);
      });
      client.on('ready', () => {
        stats.sessions += 1;
        client.on('session', (acceptSession, rejectSession) => {
          if (options.refuseSessionWith !== undefined) {
            refuseWithText(client, rejectSession, options.refuseSessionWith);
            return;
          }
          const session = acceptSession();
          session.on('sftp', (acceptSftp) => {
            const sftp = acceptSftp();
            sftp.on('error', () => undefined);
            options.serve?.(sftp);
          });
        });
      });
    },
  );

  const netServer = createServer((socket) => {
    stats.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    sshServer.injectSocket(socket);
  });
  await new Promise<void>((resolve) =>
    netServer.listen(0, '127.0.0.1', resolve),
  );
  const address = netServer.address();
  if (address === null || typeof address === 'string') {
    restore();
    throw new Error('hostile server did not get a TCP port');
  }
  const port = address.port;

  return {
    host: '127.0.0.1',
    port,
    hostKey,
    stats,
    knownHostsLine: `[127.0.0.1]:${port} ${hostKey.publicKey}`,
    liveConnections: () => sockets.size,
    close: async () => {
      restore();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => netServer.close(() => resolve()));
    },
  };
}
