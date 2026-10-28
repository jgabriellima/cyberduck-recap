import { describe, expect, it, vi } from 'vitest';
import { settleOnce } from '../../src/fs/settle-once.js';

describe('settleOnce (the one copy for every back-end)', () => {
  it('passes the first outcome and drops every later one', () => {
    const callback = vi.fn();
    const once = settleOnce(callback);
    const first = new Error('first');
    once.settle(first);
    once.settle(new Error('second'));
    once.settle();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(first);
  });

  it('is pending until it settles, also with a success', () => {
    const callback = vi.fn();
    const once = settleOnce(callback);
    expect(once.pending).toBe(true);
    once.settle();
    expect(once.pending).toBe(false);
    once.settle(new Error('late'));
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(undefined);
  });
});
