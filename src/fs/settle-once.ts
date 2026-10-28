/**
 * A callback that takes only its first outcome: a later success or error is dropped, so a stream
 * that several events can end (a reply, a closed session, a teardown) settles exactly once. The
 * one copy for every back-end (cyberduck/standard.single-source). Internal: not in the index.
 *
 * Node joins an error passed to `_construct`'s callback with one passed to an earlier destroy()
 * into an AggregateError that has no code. So while an open is pending, a session ending settles
 * the construct callback instead of destroying the stream, and only the first outcome is reported.
 */
export function settleOnce(callback: (error?: Error | null) => void): {
  readonly pending: boolean;
  settle(error?: Error): void;
} {
  let pending = true;
  return {
    get pending() {
      return pending;
    },
    settle(error?: Error): void {
      if (!pending) return;
      pending = false;
      callback(error);
    },
  };
}
