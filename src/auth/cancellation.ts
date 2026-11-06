export function loginCancelledError(): Error {
  return new Error("登录已取消");
}

// requestUrl cannot abort a native request. Stop awaiting it and discard its result.
export async function withLoginCancellation<T>(operation: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation();
  if (signal?.aborted) throw loginCancelledError();
  let cancel: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(loginCancelledError());
    signal?.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([operation(), cancelled]); }
  finally { if (cancel) signal?.removeEventListener("abort", cancel); }
}
