import type { RuleSnapshot } from './static-rule.repository';

/** Fonte de regras vista pelo processamento: devolve sempre o snapshot ativo em memória (sem I/O). */
export interface RuleRepository {
  loadActiveSnapshot(): Promise<RuleSnapshot>;
  currentRevision(): Promise<number>;
}

export const RULE_REPOSITORY = Symbol('RULE_REPOSITORY');

/** Resultado de uma consulta ao serviço de configuração. */
export type ConfigPollResult =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly content: string; readonly versionLabel?: string };

/** Cliente do serviço de configuração (AWS AppConfig em produção; falso nos testes). */
export interface RuleConfigClient {
  /** Abre a sessão de consulta. */
  start(): Promise<void>;
  /** Consulta a configuração mais recente; corpo vazio é `unchanged` (FR-013). */
  poll(): Promise<ConfigPollResult>;
}

export type ConfigClientErrorCategory =
  | 'THROTTLED'
  | 'UNAVAILABLE'
  | 'SESSION_EXPIRED'
  | 'ACCESS_DENIED'
  | 'NOT_FOUND'
  | 'UNKNOWN';

/** Erro do cliente de configuração; a mensagem nunca carrega token nem conteúdo do documento. */
export class ConfigClientError extends Error {
  constructor(
    readonly category: ConfigClientErrorCategory,
    message?: string,
  ) {
    super(message ?? category);
    this.name = 'ConfigClientError';
  }
}
