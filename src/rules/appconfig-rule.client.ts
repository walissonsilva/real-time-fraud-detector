import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from '@aws-sdk/client-appconfigdata';
import { ConfigClientError, ConfigClientErrorCategory, ConfigPollResult, RuleConfigClient } from './rule-source';

export interface AppConfigIds {
  readonly application: string;
  readonly environment: string;
  readonly profile: string;
}

export interface AppConfigClientOptions {
  /** Timeout por chamada ao AppConfig (Princípio IV): estouro vira `UNAVAILABLE`. */
  readonly requestTimeoutMs: number;
}

/** Intervalo mínimo pedido na sessão; sem isso o serviço usa 60 s (research A4). */
const MIN_POLL_INTERVAL_SECONDS = 15;

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

function categorize(err: unknown): ConfigClientErrorCategory {
  const e = err as { name?: string; code?: string } | undefined;
  switch (e?.name) {
    case 'ThrottlingException':
      return 'THROTTLED';
    case 'BadRequestException':
      return 'SESSION_EXPIRED';
    case 'AccessDeniedException':
      return 'ACCESS_DENIED';
    case 'ResourceNotFoundException':
      return 'NOT_FOUND';
    case 'InternalServerException':
    case 'ServiceUnavailableException':
    case 'TimeoutError':
    case 'AbortError':
    case 'RequestTimeout':
      return 'UNAVAILABLE';
  }
  return e?.code && NETWORK_CODES.has(e.code) ? 'UNAVAILABLE' : 'UNKNOWN';
}

/**
 * Cliente do AppConfig (plano de dados) sobre o SDK direto (research D-01): abre a sessão, guarda o token
 * de uso único a cada resposta e traduz erros em categorias. A mensagem dos erros nunca inclui o token.
 */
export class AppConfigRuleClient implements RuleConfigClient {
  private token: string | undefined;

  constructor(
    private readonly sdk: AppConfigDataClient,
    private readonly ids: AppConfigIds,
    private readonly options: AppConfigClientOptions,
  ) {}

  async start(): Promise<void> {
    const res = await this.guarded((abortSignal) =>
      this.sdk.send(
        new StartConfigurationSessionCommand({
          ApplicationIdentifier: this.ids.application,
          EnvironmentIdentifier: this.ids.environment,
          ConfigurationProfileIdentifier: this.ids.profile,
          RequiredMinimumPollIntervalInSeconds: MIN_POLL_INTERVAL_SECONDS,
        }),
        { abortSignal },
      ),
    );
    this.token = res.InitialConfigurationToken;
  }

  async poll(): Promise<ConfigPollResult> {
    if (!this.token) await this.start();
    let res;
    try {
      res = await this.guarded((abortSignal) =>
        this.sdk.send(new GetLatestConfigurationCommand({ ConfigurationToken: this.token }), { abortSignal }),
      );
    } catch (err) {
      // Token expirado/inválido: descarta a sessão; o próximo poll() abre outra (FR-014).
      if (err instanceof ConfigClientError && err.category === 'SESSION_EXPIRED') this.token = undefined;
      throw err;
    }
    this.token = res.NextPollConfigurationToken ?? this.token;
    const body = res.Configuration;
    if (!body || body.length === 0) return { kind: 'unchanged' };
    return {
      kind: 'changed',
      content: Buffer.from(body).toString('utf8'),
      versionLabel: res.VersionLabel || undefined,
    };
  }

  /** Executa uma chamada com timeout próprio: o `race` garante a rejeição mesmo que o SDK ignore o abort. */
  private async guarded<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ConfigClientError('UNAVAILABLE', 'timeout na chamada ao AppConfig'));
      }, this.options.requestTimeoutMs);
    });
    const call = run(controller.signal).catch((err: unknown) => {
      throw err instanceof ConfigClientError ? err : new ConfigClientError(categorize(err), (err as Error)?.name);
    });
    try {
      return await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
