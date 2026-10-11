import type { OnModuleDestroy } from '@nestjs/common';
import { JsonLogger } from '../observability/logger';
import { InMemoryMetrics } from '../observability/metrics';
import { DeclarativeRuleEngine } from './declarative-rule-engine';
import { ConfigClientError, ConfigPollResult, RuleConfigClient, RuleRepository } from './rule-source';
import { RulesConfigError, validateRulesDocument } from './rules-document.validator';
import type { RuleSnapshot } from './static-rule.repository';

export interface AppConfigRuleRepositoryOptions {
  /** Intervalo base entre consultas (com jitter de ±10%). */
  readonly pollIntervalMs: number;
  /** Prazo total das tentativas na partida; esgotado, `start()` rejeita e o serviço não sobe (FR-010). */
  readonly startupTimeoutMs: number;
  /** Teto de um ciclo de consulta em execução; padrão = `pollIntervalMs`. */
  readonly cycleTimeoutMs?: number;
}

export interface AppConfigRuleRepositoryDeps {
  readonly random?: () => number;
  readonly now?: () => number;
}

const JITTER = 0.1;
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 8000;
/** O AppConfig exige ao menos um caractere não numérico no Version-Label; o script publica `r<carimbo>`. */
const REVISION_LABEL = /^r?([1-9]\d*)$/;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejeita se `promise` não resolver em `ms`; a promessa original é descartada (sem vazar o timer). */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConfigClientError('UNAVAILABLE', 'tempo esgotado')), Math.max(1, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function reasonOf(err: unknown): string {
  if (err instanceof ConfigClientError) return err.category;
  if (err instanceof RulesConfigError) return 'INVALID_DOCUMENT';
  return 'UNKNOWN';
}

/**
 * Fonte de regras do AppConfig (plano, research D-02/D-04/D-08): consulta periodicamente, valida o documento com
 * `validateRulesDocument` e troca o snapshot por inteiro numa única atribuição. O caminho crítico só lê a memória.
 * Na partida repete com backoff até `startupTimeoutMs` e, sem regras válidas, rejeita; em execução, qualquer falha
 * mantém a última versão válida e é contada e registrada.
 */
export class AppConfigRuleRepository implements RuleRepository, OnModuleDestroy {
  private snapshot: RuleSnapshot | undefined;
  private timer: NodeJS.Timeout | undefined;
  private destroyed = false;
  private lastSuccessAt = 0;
  /** Verdadeiro enquanto o último documento publicado foi rejeitado: a instância segue atrás do AppConfig. */
  private rejectedLatest = false;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly client: RuleConfigClient,
    private readonly engine: DeclarativeRuleEngine,
    private readonly logger: JsonLogger,
    private readonly metrics: InMemoryMetrics,
    private readonly options: AppConfigRuleRepositoryOptions,
    deps: AppConfigRuleRepositoryDeps = {},
  ) {
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  async loadActiveSnapshot(): Promise<RuleSnapshot> {
    if (!this.snapshot) throw new Error('regras ainda não carregadas');
    return this.snapshot;
  }

  async currentRevision(): Promise<number> {
    return (await this.loadActiveSnapshot()).revision;
  }

  /** Obtém a primeira configuração válida (com retry) e inicia o laço de consulta. */
  async start(): Promise<void> {
    this.metrics.increment('rules_refresh_failures_total', undefined, 0);
    const startedAt = this.now();
    const deadline = startedAt + this.options.startupTimeoutMs;
    let delay = BACKOFF_START_MS;
    let attempts = 0;
    let lastReason = 'UNKNOWN';

    for (;;) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      attempts += 1;
      try {
        const result = await within(
          (async () => {
            await this.client.start();
            return this.client.poll();
          })(),
          remaining,
        );
        if (result.kind === 'changed') {
          this.activate(result);
          this.logger.info('rules.loaded', { revision: this.snapshot?.revision, ruleCount: this.snapshot?.rules.length, attempts });
          this.schedule();
          return;
        }
        lastReason = 'NO_CONFIGURATION';
      } catch (err) {
        lastReason = reasonOf(err);
        if (err instanceof RulesConfigError) this.logRejected(err);
      }
      const left = deadline - this.now();
      if (left <= 0) break;
      await sleep(Math.min(delay, left));
      delay = Math.min(delay * 2, BACKOFF_CAP_MS);
    }

    this.logger.error('rules.startup.failed', { reason: lastReason, attempts, timeoutMs: this.options.startupTimeoutMs });
    throw new Error(
      `não foi possível obter regras válidas do serviço de configuração em ${Math.round(this.options.startupTimeoutMs / 1000)} s (último motivo: ${lastReason})`,
    );
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.destroyed) return;
    const delay = this.options.pollIntervalMs * (1 + (this.random() * 2 - 1) * JITTER);
    this.timer = setTimeout(() => {
      void this.refresh().finally(() => this.schedule());
    }, delay);
    this.timer.unref?.();
  }

  private async refresh(): Promise<void> {
    this.updateAge();
    try {
      const result = await within(this.client.poll(), this.options.cycleTimeoutMs ?? this.options.pollIntervalMs);
      if (result.kind === 'unchanged') {
        // Com um documento rejeitado pendente, "sem mudança" não é saúde: seguimos atrás do AppConfig.
        if (this.rejectedLatest) this.recordFailure('REJECTED_DOCUMENT_PENDING');
        else this.lastSuccessAt = this.now();
      } else {
        const previousRevision = this.snapshot?.revision;
        try {
          this.activate(result);
          this.logger.info('rules.refresh.ok', { previousRevision, revision: this.snapshot?.revision, ruleCount: this.snapshot?.rules.length });
        } catch (err) {
          this.rejectedLatest = true;
          this.logRejected(err);
          this.recordFailure('INVALID_DOCUMENT', false);
        }
      }
    } catch (err) {
      this.recordFailure(reasonOf(err));
    }
    this.updateAge();
  }

  /** Valida o conteúdo e, se válido, troca o snapshot por inteiro. Lança `RulesConfigError` se não puder ativar. */
  private activate(result: Extract<ConfigPollResult, { kind: 'changed' }>): void {
    const match = REVISION_LABEL.exec(result.versionLabel ?? '');
    const revision = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(revision)) {
      throw new RulesConfigError('conteúdo sem rótulo de versão numérico (Version-Label)');
    }
    const { rules } = validateRulesDocument(result.content, { engine: this.engine });
    this.snapshot = Object.freeze({ revision, rules });
    this.rejectedLatest = false;
    this.lastSuccessAt = this.now();
    this.metrics.gauge('rules_active_revision', revision);
    this.updateAge();
  }

  private recordFailure(reason: string, log = true): void {
    this.metrics.increment('rules_refresh_failures_total');
    if (log) this.logger.warn('rules.refresh.failed', { reason, revision: this.snapshot?.revision });
  }

  private logRejected(err: unknown): void {
    // A mensagem de RulesConfigError cita apenas posição, ruleId e a regra violada (FR-015).
    this.logger.warn('rules.document.rejected', { reason: err instanceof RulesConfigError ? err.message : reasonOf(err), revision: this.snapshot?.revision });
  }

  private updateAge(): void {
    this.metrics.gauge('rules_last_refresh_age_seconds', Math.max(0, Math.floor((this.now() - this.lastSuccessAt) / 1000)));
  }
}
