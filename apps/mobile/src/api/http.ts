/**
 * fetch() with a timeout. React Native's Android HTTP client has no timeouts at all,
 * so a server that accepts the connection and then stalls would hang the caller (and
 * anything single-flighted behind it, like the feed refresh) for the whole session.
 *
 * Pass `read` to consume the body inside the timeout too (fetch may resolve as soon as
 * headers arrive, and a stalled body would otherwise hang `res.text()`).
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Response>;
export async function fetchWithTimeout<T>(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number | undefined,
  read: (res: Response) => Promise<T>,
): Promise<T>;
export async function fetchWithTimeout<T>(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  read?: (res: Response) => Promise<T>,
): Promise<Response | T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const outerSignal = init.signal;
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onOuterAbort);
  }
  try {
    const res = await fetch(input, { ...init, signal: controller.signal });
    return read ? await read(res) : res;
  } catch (error) {
    if (timedOut) {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s: ${input.split('?')[0]}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', onOuterAbort);
  }
}
