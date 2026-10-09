import { createHash } from 'node:crypto';

/** sha256("fraud-alert:v1:" + transactionId): um alerta por transação (FR-017). */
export function dedupeKeyOf(transactionId: string): string {
  return createHash('sha256').update(`fraud-alert:v1:${transactionId}`).digest('hex');
}
