import { Global, Module } from '@nestjs/common';

export type RulesSource = 'file' | 'appconfig';

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  aws: { region: string; endpoint?: string };
  queues: {
    transactions: string;
    transactionsDlq: string;
    antifraudChannel: string;
    customerChannel: string;
    antifraudChannelDlq: string;
    customerChannelDlq: string;
  };
  snsAlertsTopic: string;
  /** ARN do tópico; quando definido, dispensa o CreateTopic (ex.: AWS, onde o Terraform cria o tópico). */
  snsAlertsTopicArn?: string;
  snsPublishTimeoutMs: number;
  outboxRelay: { intervalMs: number; minAgeMs: number; batchSize: number };
  rulesConfigPath: string;
  /** Fonte das regras: `file` (dev/testes) ou `appconfig` (padrão em produção). */
  rulesSource: RulesSource;
  appconfig: { application: string; environment: string; profile: string };
  rules: { pollIntervalMs: number; startupTimeoutMs: number; requestTimeoutMs: number; metricsLog: boolean };
  consumers: { enabled: boolean; channelsEnabled: boolean; transactionPollers: number; channelPollers: number };
  channels: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    sendTimeoutMs: number;
    /** Injeção de falha nos provedores simulados (demonstração/testes). */
    failAntifraud: boolean;
    failCustomer: boolean;
    failSms: boolean;
    /** Falhas consecutivas que abrem o circuit breaker de um canal e tempo aberto antes da sonda. */
    breakerFailureThreshold: number;
    breakerOpenMs: number;
    /** Kill switch: canal desligado por configuração (breaker forçado aberto; push cai no fallback SMS). */
    disabledAntifraud: boolean;
    disabledCustomer: boolean;
    disabledSms: boolean;
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Variável de ambiente inválida (inteiro >= 0): ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function rulesSourceFromEnv(): RulesSource {
  const raw = process.env.RULES_SOURCE;
  if (raw === undefined || raw === '') return process.env.NODE_ENV === 'production' ? 'appconfig' : 'file';
  if (raw !== 'file' && raw !== 'appconfig') throw new Error("Variável de ambiente inválida (use 'file' ou 'appconfig'): RULES_SOURCE");
  return raw;
}

export function loadConfig(): AppConfig {
  const rulesSource = rulesSourceFromEnv();
  const fromAppConfig = rulesSource === 'appconfig';
  return {
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
    aws: { region: optional('AWS_REGION', 'us-east-1'), endpoint: process.env.AWS_ENDPOINT_URL || undefined },
    queues: {
      transactions: optional('SQS_TRANSACTIONS_QUEUE', 'transactions'),
      transactionsDlq: optional('SQS_TRANSACTIONS_DLQ', 'transactions-dlq'),
      antifraudChannel: optional('SQS_CHANNEL_ANTIFRAUD_QUEUE', 'alert-deliveries-antifraud-queue.fifo'),
      customerChannel: optional('SQS_CHANNEL_CUSTOMER_QUEUE', 'alert-deliveries-customer-push.fifo'),
      antifraudChannelDlq: optional('SQS_CHANNEL_ANTIFRAUD_DLQ', 'alert-deliveries-antifraud-queue-dlq.fifo'),
      customerChannelDlq: optional('SQS_CHANNEL_CUSTOMER_DLQ', 'alert-deliveries-customer-push-dlq.fifo'),
    },
    snsAlertsTopic: optional('SNS_ALERTS_TOPIC', 'alerts.fifo'),
    snsAlertsTopicArn: process.env.SNS_ALERTS_TOPIC_ARN || undefined,
    snsPublishTimeoutMs: int('SNS_PUBLISH_TIMEOUT_MS', 2000),
    outboxRelay: {
      intervalMs: int('OUTBOX_RELAY_INTERVAL_MS', 1000),
      minAgeMs: int('OUTBOX_RELAY_MIN_AGE_MS', 2000),
      batchSize: int('OUTBOX_RELAY_BATCH_SIZE', 100),
    },
    rulesConfigPath: optional('RULES_CONFIG_PATH', 'config/rules.json'),
    rulesSource,
    appconfig: {
      application: fromAppConfig ? required('APPCONFIG_APPLICATION') : optional('APPCONFIG_APPLICATION', ''),
      environment: fromAppConfig ? required('APPCONFIG_ENVIRONMENT') : optional('APPCONFIG_ENVIRONMENT', ''),
      profile: fromAppConfig ? required('APPCONFIG_PROFILE') : optional('APPCONFIG_PROFILE', ''),
    },
    rules: {
      pollIntervalMs: Math.max(1000, int('RULES_POLL_INTERVAL_MS', 20000)),
      startupTimeoutMs: int('RULES_STARTUP_TIMEOUT_MS', 45000),
      requestTimeoutMs: Math.max(100, int('RULES_REQUEST_TIMEOUT_MS', 5000)),
      metricsLog: optional('RULES_METRICS_LOG', 'false') === 'true',
    },
    consumers: {
      enabled: optional('CONSUMERS_ENABLED', 'true') !== 'false',
      channelsEnabled: optional('CHANNEL_CONSUMERS_ENABLED', 'true') !== 'false',
      transactionPollers: Math.max(1, int('SQS_TRANSACTION_POLLERS', 4)),
      channelPollers: Math.max(1, int('SQS_CHANNEL_POLLERS', 2)),
    },
    channels: {
      maxAttempts: Math.max(1, int('CHANNEL_DELIVERY_MAX_ATTEMPTS', 3)),
      baseDelayMs: int('CHANNEL_DELIVERY_BASE_DELAY_MS', 200),
      maxDelayMs: int('CHANNEL_DELIVERY_MAX_DELAY_MS', 2000),
      sendTimeoutMs: int('CHANNEL_SEND_TIMEOUT_MS', 2000),
      failAntifraud: optional('CHANNEL_ANTIFRAUD_FAIL', 'false') === 'true',
      failCustomer: optional('CHANNEL_CUSTOMER_FAIL', 'false') === 'true',
      failSms: optional('CHANNEL_SMS_FAIL', 'false') === 'true',
      breakerFailureThreshold: Math.max(1, int('CHANNEL_BREAKER_FAILURE_THRESHOLD', 5)),
      breakerOpenMs: int('CHANNEL_BREAKER_OPEN_MS', 30000),
      disabledAntifraud: optional('CHANNEL_ANTIFRAUD_DISABLED', 'false') === 'true',
      disabledCustomer: optional('CHANNEL_CUSTOMER_DISABLED', 'false') === 'true',
      disabledSms: optional('CHANNEL_SMS_DISABLED', 'false') === 'true',
    },
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: loadConfig }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
