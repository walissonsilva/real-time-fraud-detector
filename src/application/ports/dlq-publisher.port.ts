import { DlqMessage } from '../../domain/dlq/dlq-message';

export interface DlqPublisher {
  /** `queue` é o nome lógico da DLQ de destino (ex.: `transactions-dlq`). Rejeita se o envio falhar. */
  publish(queue: string, message: DlqMessage): Promise<void>;
}
export const DLQ_PUBLISHER = Symbol('DlqPublisher');
