export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  readonly code = 'CircuitOpen';
  constructor(readonly retryAfterMs: number) {
    super('circuit breaker aberto');
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly openDurationMs: number;
  readonly now?: () => number;
  readonly onStateChange?: (state: BreakerState, previous: BreakerState) => void;
}

/** CLOSED → OPEN (falhas consecutivas) → HALF_OPEN (uma única sonda) → CLOSED ou OPEN. `forcedOpen` recusa tudo, sem sondas. */
export class CircuitBreaker {
  forcedOpen = false;
  private current: BreakerState = 'CLOSED';
  private failures = 0;
  private openedAt = 0;
  private probing = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? (() => performance.now());
  }

  /** Estado observável; o kill switch aparece como OPEN. */
  get state(): BreakerState {
    return this.forcedOpen ? 'OPEN' : this.current;
  }

  retryAfterMs(): number {
    if (this.forcedOpen) return this.options.openDurationMs;
    if (this.current === 'OPEN') return Math.max(0, this.openedAt + this.options.openDurationMs - this.now());
    if (this.current === 'HALF_OPEN') return 1000;
    return 0;
  }

  async exec<T>(run: () => Promise<T>): Promise<T> {
    this.admit();
    try {
      const value = await run();
      this.onSuccess();
      return value;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private admit(): void {
    if (this.forcedOpen) throw new CircuitOpenError(this.retryAfterMs());
    if (this.current === 'CLOSED') return;
    if (this.current === 'OPEN') {
      if (this.now() - this.openedAt < this.options.openDurationMs) throw new CircuitOpenError(this.retryAfterMs());
      this.transition('HALF_OPEN');
    }
    if (this.probing) throw new CircuitOpenError(this.retryAfterMs());
    this.probing = true;
  }

  private onSuccess(): void {
    if (this.current === 'HALF_OPEN') {
      this.probing = false;
      this.failures = 0;
      this.transition('CLOSED');
    } else if (this.current === 'CLOSED') {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    if (this.current === 'HALF_OPEN') {
      this.probing = false;
      this.open();
    } else if (this.current === 'CLOSED' && ++this.failures >= this.options.failureThreshold) {
      this.open();
    }
  }

  private open(): void {
    this.openedAt = this.now();
    this.transition('OPEN');
  }

  private transition(next: BreakerState): void {
    const previous = this.current;
    this.current = next;
    this.options.onStateChange?.(next, previous);
  }
}
