import { Global, Module } from '@nestjs/common';

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
  snsPublishTimeoutMs: number;
  outboxRelay: { intervalMs: number; minAgeMs: number; batchSize: number };
  rulesConfigPath: string;
  consumers: { enabled: boolean; transactionPollers: number };
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

export function loadConfig(): AppConfig {
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
    snsPublishTimeoutMs: int('SNS_PUBLISH_TIMEOUT_MS', 2000),
    outboxRelay: {
      intervalMs: int('OUTBOX_RELAY_INTERVAL_MS', 1000),
      minAgeMs: int('OUTBOX_RELAY_MIN_AGE_MS', 2000),
      batchSize: int('OUTBOX_RELAY_BATCH_SIZE', 100),
    },
    rulesConfigPath: optional('RULES_CONFIG_PATH', 'config/rules.json'),
    consumers: {
      enabled: optional('CONSUMERS_ENABLED', 'true') !== 'false',
      transactionPollers: Math.max(1, int('SQS_TRANSACTION_POLLERS', 4)),
    },
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: loadConfig }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
