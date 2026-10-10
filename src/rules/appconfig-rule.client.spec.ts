import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from '@aws-sdk/client-appconfigdata';
import { AppConfigRuleClient } from './appconfig-rule.client';
import { ConfigClientError } from './rule-source';

const ids = { application: 'app-1', environment: 'env-1', profile: 'prof-1' };
const bytes = (s: string) => new TextEncoder().encode(s);

function fakeSdk(handler: (cmd: unknown, opts?: { abortSignal?: AbortSignal }) => unknown | Promise<unknown>) {
  const send = jest.fn(async (cmd: unknown, opts?: { abortSignal?: AbortSignal }) => handler(cmd, opts));
  return { sdk: { send } as unknown as AppConfigDataClient, send };
}

const awsError = (name: string) => Object.assign(new Error(name), { name });

describe('AppConfigRuleClient', () => {
  afterEach(() => jest.useRealTimers());

  it('start() abre a sessão pedindo intervalo mínimo de 15 s e guarda o token inicial', async () => {
    const { sdk, send } = fakeSdk(() => ({ InitialConfigurationToken: 'tok-0' }));
    await new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 }).start();
    const cmd = send.mock.calls[0][0] as StartConfigurationSessionCommand;
    expect(cmd).toBeInstanceOf(StartConfigurationSessionCommand);
    expect(cmd.input).toMatchObject({
      ApplicationIdentifier: 'app-1',
      EnvironmentIdentifier: 'env-1',
      ConfigurationProfileIdentifier: 'prof-1',
      RequiredMinimumPollIntervalInSeconds: 15,
    });
  });

  it('poll() usa o token e substitui por NextPollConfigurationToken a cada resposta (token de uso único)', async () => {
    const tokens: string[] = [];
    const { sdk } = fakeSdk((cmd) => {
      if (cmd instanceof StartConfigurationSessionCommand) return { InitialConfigurationToken: 'tok-0' };
      tokens.push((cmd as GetLatestConfigurationCommand).input.ConfigurationToken as string);
      return { Configuration: new Uint8Array(), NextPollConfigurationToken: `tok-${tokens.length}` };
    });
    const client = new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 });
    await client.start();
    await client.poll();
    await client.poll();
    await client.poll();
    expect(tokens).toEqual(['tok-0', 'tok-1', 'tok-2']);
  });

  it('corpo vazio vira "unchanged" (nunca lista vazia de regras)', async () => {
    const { sdk } = fakeSdk((cmd) =>
      cmd instanceof StartConfigurationSessionCommand
        ? { InitialConfigurationToken: 't' }
        : { Configuration: new Uint8Array(), NextPollConfigurationToken: 't2', VersionLabel: '' },
    );
    const client = new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 });
    await client.start();
    expect(await client.poll()).toEqual({ kind: 'unchanged' });
  });

  it('corpo com conteúdo vira "changed" com o Version-Label', async () => {
    const { sdk } = fakeSdk((cmd) =>
      cmd instanceof StartConfigurationSessionCommand
        ? { InitialConfigurationToken: 't' }
        : { Configuration: bytes('{"rules":[]}'), NextPollConfigurationToken: 't2', VersionLabel: '20261010120000' },
    );
    const client = new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 });
    await client.start();
    expect(await client.poll()).toEqual({ kind: 'changed', content: '{"rules":[]}', versionLabel: '20261010120000' });
  });

  it('sem Version-Label, o resultado "changed" não traz rótulo', async () => {
    const { sdk } = fakeSdk((cmd) =>
      cmd instanceof StartConfigurationSessionCommand
        ? { InitialConfigurationToken: 't' }
        : { Configuration: bytes('{}'), NextPollConfigurationToken: 't2' },
    );
    const client = new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 });
    await client.start();
    expect(await client.poll()).toEqual({ kind: 'changed', content: '{}', versionLabel: undefined });
  });

  it('poll() sem sessão abre a sessão sozinho', async () => {
    const { sdk, send } = fakeSdk((cmd) =>
      cmd instanceof StartConfigurationSessionCommand
        ? { InitialConfigurationToken: 't' }
        : { Configuration: new Uint8Array(), NextPollConfigurationToken: 't2' },
    );
    await new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 }).poll();
    expect(send.mock.calls[0][0]).toBeInstanceOf(StartConfigurationSessionCommand);
  });

  it.each([
    ['ThrottlingException', 'THROTTLED'],
    ['BadRequestException', 'SESSION_EXPIRED'],
    ['InternalServerException', 'UNAVAILABLE'],
    ['ServiceUnavailableException', 'UNAVAILABLE'],
    ['TimeoutError', 'UNAVAILABLE'],
    ['AccessDeniedException', 'ACCESS_DENIED'],
    ['ResourceNotFoundException', 'NOT_FOUND'],
    ['Qualquer', 'UNKNOWN'],
  ])('erro %s do SDK vira ConfigClientError %s', async (name, category) => {
    const { sdk } = fakeSdk(() => {
      throw awsError(name);
    });
    await expect(new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 }).start()).rejects.toMatchObject({
      name: 'ConfigClientError',
      category,
    });
  });

  it('erro de rede (código ECONNRESET) vira UNAVAILABLE', async () => {
    const { sdk } = fakeSdk(() => {
      throw Object.assign(new Error('socket'), { code: 'ECONNRESET' });
    });
    await expect(new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 }).start()).rejects.toMatchObject({
      category: 'UNAVAILABLE',
    });
  });

  it('após SESSION_EXPIRED o próximo poll() reabre a sessão (FR-014)', async () => {
    let getCalls = 0;
    const { sdk, send } = fakeSdk((cmd) => {
      if (cmd instanceof StartConfigurationSessionCommand) return { InitialConfigurationToken: 'novo' };
      getCalls += 1;
      if (getCalls === 1) throw awsError('BadRequestException');
      return { Configuration: new Uint8Array(), NextPollConfigurationToken: 'n2' };
    });
    const client = new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 });
    await client.start();
    await expect(client.poll()).rejects.toMatchObject({ category: 'SESSION_EXPIRED' });
    await expect(client.poll()).resolves.toEqual({ kind: 'unchanged' });
    const kinds = send.mock.calls.map(([c]) => (c as object).constructor.name);
    expect(kinds).toEqual([
      'StartConfigurationSessionCommand',
      'GetLatestConfigurationCommand',
      'StartConfigurationSessionCommand',
      'GetLatestConfigurationCommand',
    ]);
  });

  it('chamada que excede o timeout rejeita com UNAVAILABLE, mesmo que o SDK ignore o abort (C1)', async () => {
    jest.useFakeTimers();
    const { sdk } = fakeSdk(() => new Promise(() => undefined));
    const promise = new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 5000 }).start();
    const assertion = expect(promise).rejects.toMatchObject({ category: 'UNAVAILABLE' });
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('a chamada recebe um AbortSignal que é acionado no timeout', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { sdk } = fakeSdk((_cmd, opts) => {
      signal = opts?.abortSignal;
      return new Promise(() => undefined);
    });
    const promise = new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 100 }).start();
    promise.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(100);
    expect(signal?.aborted).toBe(true);
  });

  it('o erro nunca carrega o token de sessão', async () => {
    const { sdk } = fakeSdk((cmd) => {
      if (cmd instanceof StartConfigurationSessionCommand) return { InitialConfigurationToken: 'SEGREDO-TOKEN' };
      throw awsError('InternalServerException');
    });
    const client = new AppConfigRuleClient(sdk, ids, { requestTimeoutMs: 1000 });
    await client.start();
    const err = await client.poll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigClientError);
    expect(JSON.stringify([(err as Error).message, (err as Error).stack])).not.toContain('SEGREDO-TOKEN');
  });
});
