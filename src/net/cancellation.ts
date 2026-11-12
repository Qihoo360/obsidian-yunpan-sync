export class RequestCancelledError extends Error {
  constructor(message = "请求已取消") {
    super(message);
    this.name = "RequestCancelledError";
  }
}

/** Races a request with the current synchronization cancellation signal.
 * The underlying host request may not support AbortSignal; in that case its
 * late result is ignored and the caller can finish its cancellation path. */
export async function cancellable<T>(operation: Promise<T>, signal?: AbortSignal,
  check?: () => void): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    check?.();
    throw new RequestCancelledError();
  }
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new RequestCancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } catch (error) {
    if (signal.aborted) {
      check?.();
      throw new RequestCancelledError();
    }
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
