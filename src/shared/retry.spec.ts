import { backoffDelayMs, retry, TimeoutError } from './retry';

describe('retry', () => {
  const noRandom = () => 0.999999;

  it('retorna na primeira tentativa bem-sucedida', async () => {
    const run = jest.fn().mockResolvedValue('ok');
    await expect(retry(run, { attempts: 3, baseDelayMs: 10 })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('respeita o limite de tentativas e propaga o último erro', async () => {
    const run = jest.fn().mockImplementation(() => Promise.reject(new Error(`falha ${run.mock.calls.length}`)));
    const sleep = jest.fn().mockResolvedValue(undefined);
    await expect(retry(run, { attempts: 3, baseDelayMs: 10, sleep, random: noRandom })).rejects.toThrow('falha 3');
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('cresce a espera entre tentativas e respeita o teto', () => {
    expect(backoffDelayMs(1, 100, 1000, noRandom)).toBe(99);
    expect(backoffDelayMs(2, 100, 1000, noRandom)).toBe(199);
    expect(backoffDelayMs(3, 100, 1000, noRandom)).toBe(399);
    expect(backoffDelayMs(10, 100, 1000, noRandom)).toBe(999);
  });

  it('recupera após falha transitória', async () => {
    const run = jest.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue('ok');
    await expect(retry(run, { attempts: 2, baseDelayMs: 1, sleep: async () => undefined })).resolves.toBe('ok');
  });

  it('aborta a tentativa que excede o timeout', async () => {
    const run = () => new Promise<string>(() => undefined);
    await expect(retry(run, { attempts: 1, baseDelayMs: 1, timeoutMs: 10 })).rejects.toBeInstanceOf(TimeoutError);
  });
});
