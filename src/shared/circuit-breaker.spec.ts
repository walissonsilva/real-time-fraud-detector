import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

function setup(failureThreshold = 3, openDurationMs = 1000) {
  let t = 0;
  const changes: string[] = [];
  const breaker = new CircuitBreaker({
    failureThreshold,
    openDurationMs,
    now: () => t,
    onStateChange: (s, p) => changes.push(`${p}>${s}`),
  });
  return { breaker, changes, advance: (ms: number) => (t += ms) };
}

const ok = async () => 'ok';
const boom = async () => {
  throw new Error('falhou');
};

describe('CircuitBreaker', () => {
  it('abre após N falhas consecutivas e recusa sem chamar o provedor', async () => {
    const { breaker, changes } = setup();
    for (let i = 0; i < 3; i++) await expect(breaker.exec(boom)).rejects.toThrow('falhou');
    expect(breaker.state).toBe('OPEN');
    const run = jest.fn(ok);
    await expect(breaker.exec(run)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(run).not.toHaveBeenCalled();
    expect(changes).toEqual(['CLOSED>OPEN']);
  });

  it('sucesso zera a contagem de falhas consecutivas', async () => {
    const { breaker } = setup();
    await expect(breaker.exec(boom)).rejects.toThrow();
    await expect(breaker.exec(boom)).rejects.toThrow();
    await breaker.exec(ok);
    await expect(breaker.exec(boom)).rejects.toThrow();
    await expect(breaker.exec(boom)).rejects.toThrow();
    expect(breaker.state).toBe('CLOSED');
  });

  it('meio-aberto: uma sonda; sucesso fecha', async () => {
    const { breaker, changes, advance } = setup();
    for (let i = 0; i < 3; i++) await expect(breaker.exec(boom)).rejects.toThrow();
    expect(breaker.retryAfterMs()).toBe(1000);
    advance(1000);
    await expect(breaker.exec(ok)).resolves.toBe('ok');
    expect(breaker.state).toBe('CLOSED');
    expect(changes).toEqual(['CLOSED>OPEN', 'OPEN>HALF_OPEN', 'HALF_OPEN>CLOSED']);
  });

  it('meio-aberto: sonda que falha reabre e reinicia o tempo', async () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i++) await expect(breaker.exec(boom)).rejects.toThrow();
    advance(1000);
    await expect(breaker.exec(boom)).rejects.toThrow('falhou');
    expect(breaker.state).toBe('OPEN');
    expect(breaker.retryAfterMs()).toBe(1000);
    await expect(breaker.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('meio-aberto: só uma sonda em voo; as demais são recusadas', async () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i++) await expect(breaker.exec(boom)).rejects.toThrow();
    advance(1000);
    let release!: () => void;
    const probe = breaker.exec(() => new Promise<string>((resolve) => (release = () => resolve('ok'))));
    await expect(breaker.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await expect(probe).resolves.toBe('ok');
    expect(breaker.state).toBe('CLOSED');
  });

  it('forcedOpen (kill switch) recusa tudo, sem sonda, e some ao desligar', async () => {
    const { breaker, advance } = setup();
    breaker.forcedOpen = true;
    advance(10_000);
    expect(breaker.state).toBe('OPEN');
    await expect(breaker.exec(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    breaker.forcedOpen = false;
    await expect(breaker.exec(ok)).resolves.toBe('ok');
    expect(breaker.state).toBe('CLOSED');
  });
});
