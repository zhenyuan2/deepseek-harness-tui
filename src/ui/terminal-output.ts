interface OutputHandle { setBlocking(blocking: boolean): unknown }
interface OutputState { handle: OutputHandle; users: number; generation: number; nonblocking: boolean }
export interface OutputLease {
  /** Release this lease; the last lease restores blocking after pending writes flush. */
  (): void;
  /** Restore blocking immediately for a synchronous emergency shutdown. */
  block(): void;
  /** The handle accepted nonblocking mode, so a last-resort writeSync cannot block. */
  nonblocking: boolean;
}
const outputs = new WeakMap<object, OutputState>();

/** Node creates TTY streams in blocking mode, which can stall stdin as well. */
export function useNonBlockingOutput(output: typeof process.stdout): OutputLease {
  let state = outputs.get(output);
  if (!state) {
    // Node exposes no public equivalent of its TTY handle's setBlocking().
    const handle = (output as typeof output & { _handle?: OutputHandle })._handle;
    if (!handle?.setBlocking) return Object.assign(() => {}, { block() {}, nonblocking: false });
    const result = handle.setBlocking(false);
    state = { handle, users: 0, generation: 0, nonblocking: result === 0 || result === undefined };
    outputs.set(output, state);
  }
  const current = state;
  current.users++;
  let released = false;
  const release = (() => {
    if (released) return;
    released = true;
    if (--current.users) return;
    // Only the callback belonging to the final release may restore blocking.
    // An earlier mount can release, be replaced, and have the replacement
    // release again before this callback runs.
    const generation = ++current.generation;
    output.write('', () => {
      if (current.users || current.generation !== generation || outputs.get(output) !== current) return;
      outputs.delete(output);
      current.nonblocking = false;
      current.handle.setBlocking(true);
    });
  }) as OutputLease;
  Object.defineProperty(release, 'nonblocking', { get: () => current.nonblocking });
  release.block = () => {
    // Invalidate pending release callbacks before forcing the handle back to
    // blocking, so a shutdown cannot be followed by a stale async restore.
    current.nonblocking = false;
    current.generation++;
    if (outputs.get(output) === current) outputs.delete(output);
    current.handle.setBlocking(true);
  };
  return release;
}
