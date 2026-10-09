export interface RetryOptions {
  /** Número total de tentativas (>= 1). */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs?: number;
  /** Limite de tempo por tentativa. */
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Devolve um número em [0, 1); injetável para testes. */
  readonly random?: () => number;
}

export class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout após ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Espera exponencial com jitter total: random * min(max, base * 2^(tentativa-1)). */
export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs = Infinity, random = Math.random): number {
  return Math.floor(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
}

function withTimeout<T>(run: () => Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs) return run();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs);
    run().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function retry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await withTimeout(run, options.timeoutMs);
    } catch (err) {
      lastError = err;
      if (attempt < options.attempts) {
        await sleep(backoffDelayMs(attempt, options.baseDelayMs, options.maxDelayMs, options.random));
      }
    }
  }
  throw lastError;
}
