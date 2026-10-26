import { describe, expect, it } from 'vitest';
import { RemoteFsError } from '../../src/index.js';
import {
  MalformedReplyError,
  SFTP_STATUS,
  SftpStatusError,
  classifyConnectError,
  isMalformedReply,
  mapStatus,
  messageOf,
  sanitizedCause,
  statusOf,
  toRemoteFsError,
} from '../../src/sftp/error-map.js';

const context = { operation: 'stat', path: '/p' };

describe('SFTP status mapping table (M-2)', () => {
  it.each([
    [SFTP_STATUS.NO_SUCH_FILE, 'NOT_FOUND'],
    [SFTP_STATUS.PERMISSION_DENIED, 'PERMISSION_DENIED'],
    [SFTP_STATUS.FAILURE, 'OPERATION_FAILED'],
    [SFTP_STATUS.FILE_ALREADY_EXISTS, 'ALREADY_EXISTS'],
    [SFTP_STATUS.NO_CONNECTION, 'CONNECTION_LOST'],
    [SFTP_STATUS.CONNECTION_LOST, 'CONNECTION_LOST'],
    [SFTP_STATUS.BAD_MESSAGE, 'OPERATION_FAILED'],
    [SFTP_STATUS.OP_UNSUPPORTED, 'OPERATION_FAILED'],
    [99, 'OPERATION_FAILED'],
  ])('status %i maps to %s with the path', (status, code) => {
    const error = mapStatus(status, 'text', context);

    expect(error).toBeInstanceOf(RemoteFsError);
    expect(error.code).toBe(code);
    expect(error.path).toBe('/p');
    expect(error.message).toContain('/p');
  });

  it('OPERATION_FAILED carries the sanitised server text', () => {
    const error = mapStatus(
      SFTP_STATUS.FAILURE,
      'Directory not empty\u001b',
      context,
    );
    expect(error.message).toContain('Directory not empty\\x1b');
  });

  it('OPERATION_FAILED escapes bidi and separator characters in the server text', () => {
    const error = mapStatus(
      SFTP_STATUS.FAILURE,
      'x\u202ey\u2028z\u2066',
      context,
    );

    expect(error.code).toBe('OPERATION_FAILED');
    expect(error.message).toContain('x\\u202ey\\u2028z\\u2066');
    expect(error.message).not.toMatch(
      /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/u,
    );
  });

  it('a status without text names the status', () => {
    expect(mapStatus(SFTP_STATUS.FAILURE, '', context).message).toContain(
      'status 4',
    );
  });

  it('rename errors carry path = from and targetPath = to', () => {
    const error = mapStatus(SFTP_STATUS.PERMISSION_DENIED, '', {
      operation: 'rename',
      path: '/from',
      targetPath: '/to',
    });
    expect(error).toMatchObject({ path: '/from', targetPath: '/to' });
  });

  it('toRemoteFsError adds the paths to session errors and maps status errors', () => {
    const lost = toRemoteFsError(
      new RemoteFsError('CONNECTION_LOST', 'lost'),
      context,
    );
    expect(lost).toMatchObject({ code: 'CONNECTION_LOST', path: '/p' });
    expect(toRemoteFsError(new SftpStatusError(2, ''), context).code).toBe(
      'NOT_FOUND',
    );
    expect(toRemoteFsError(new Error('?'), context).code).toBe(
      'OPERATION_FAILED',
    );
  });

  it('statusOf reads only numeric codes', () => {
    expect(statusOf(Object.assign(new Error(), { code: 3 }))).toBe(3);
    expect(
      statusOf(Object.assign(new Error(), { code: 'ECONNRESET' })),
    ).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
  });

  it('connect-phase errors: client-authentication is AUTH_FAILED, the rest CONNECTION_FAILED', () => {
    expect(classifyConnectError({ level: 'client-authentication' })).toBe(
      'AUTH_FAILED',
    );
    expect(classifyConnectError({ level: 'client-socket' })).toBe(
      'CONNECTION_FAILED',
    );
    expect(classifyConnectError({ level: 'handshake' })).toBe(
      'CONNECTION_FAILED',
    );
  });

  it('sanitizedCause keeps only a message and a code', () => {
    const original = Object.assign(new Error('refused\n'), {
      code: 'ECONNREFUSED',
      config: { secret: 'x' },
    });
    const cause = sanitizedCause(original);

    expect(cause).not.toBe(original);
    expect(cause.message).toBe('refused\\x0a');
    expect(Object.keys(cause)).toEqual(['code']);
  });

  it('sanitizedCause escapes bidi and separator characters', () => {
    const cause = sanitizedCause(new Error('a\u202eb\u2029c\u2069'));

    expect(cause).toBeInstanceOf(Error);
    expect(cause.message).toBe('a\\u202eb\\u2029c\\u2069');
    expect(cause.message).toHaveLength(21);
  });

  it('reads that throw give a safe cause, no status and a connection failure, never a throw', () => {
    const fail = (): never => {
      throw new Error('trap');
    };
    const proxy = new Proxy(new Error('x'), {
      get: fail,
      getPrototypeOf: fail,
    });
    const getters = new Error('placeholder');
    Object.defineProperty(getters, 'message', { get: fail });
    Object.defineProperty(getters, 'code', { get: fail });
    Object.defineProperty(getters, 'level', { get: fail });

    for (const error of [proxy, getters]) {
      const cause = sanitizedCause(error);
      expect(cause).toBeInstanceOf(Error);
      expect(cause.message).toBe('unknown');
      expect(Object.keys(cause)).toEqual([]);
      expect(statusOf(error)).toBeUndefined();
      expect(classifyConnectError(error)).toBe('CONNECTION_FAILED');
    }
  });

  it('isMalformedReply and messageOf answer a hostile error without throwing', () => {
    const fail = (): never => {
      throw new Error('trap');
    };
    const proxy = new Proxy(new MalformedReplyError('handle'), {
      getPrototypeOf: fail,
    });
    const getter = new Error('placeholder');
    Object.defineProperty(getter, 'message', { get: fail });

    expect(isMalformedReply(new MalformedReplyError('handle'))).toBe(true);
    expect(isMalformedReply(proxy)).toBe(false);
    expect(messageOf(new Error('denied'))).toBe('denied');
    expect(messageOf(getter)).toBe('');
    expect(messageOf(Object.assign(new Error(), { message: 42 }))).toBe('');
    expect(messageOf(null)).toBe('');
  });
});

describe('toRemoteFsError on hostile malformed replies', () => {
  /* eslint-disable-next-line no-control-regex -- the set under test is control and format characters */
  const unsafe = /[\u0007\u009b\u2028\u202e\u2066]/u;
  const forged = (message: unknown): unknown =>
    Object.create(MalformedReplyError.prototype, {
      message: { value: message },
    });

  it('drops the hostile message of a forged malformed reply', () => {
    const error = toRemoteFsError(
      forged(`a\u202eb\u2066c\u2028d\u0007${'x'.repeat(600)}`),
      context,
    );
    expect(error.code).toBe('OPERATION_FAILED');
    expect(error.message).not.toMatch(unsafe);
    expect(error.message.length).toBeLessThan(300);
  });

  it('maps a malformed reply whose reads throw to a typed error, never a throw', () => {
    const trap = (): never => {
      throw new Error('trap');
    };
    const proxy = new Proxy(new MalformedReplyError('handle'), { get: trap });
    expect(toRemoteFsError(proxy, context)).toBeInstanceOf(RemoteFsError);
    expect(toRemoteFsError(forged({ toString: trap }), context).message).toBe(
      "stat /p: the server's reply carried no valid payload",
    );
    const status = new Proxy(new SftpStatusError(4, 'x'), { get: trap });
    expect(toRemoteFsError(status, context).code).toBe('OPERATION_FAILED');
  });

  it('copyOf rebuilds the message from our own text, never the original', () => {
    const copy = MalformedReplyError.copyOf(forged('a\u202eb'));
    expect(Object.getPrototypeOf(copy)).toBe(MalformedReplyError.prototype);
    expect(copy.message).toBe("the server's reply carried no valid payload");
    expect(
      MalformedReplyError.copyOf(new MalformedReplyError('attributes')).message,
    ).toBe("the server's reply carried no attributes");
  });

  it('a forged status error with a non-number status names no raw text', () => {
    const status: unknown = Object.create(SftpStatusError.prototype, {
      status: { value: { toString: () => 'a\u202eb' } },
      serverText: { value: '' },
    });
    const error = toRemoteFsError(status, context);
    expect(error.message).toBe('stat /p: server status NaN');
  });
});
