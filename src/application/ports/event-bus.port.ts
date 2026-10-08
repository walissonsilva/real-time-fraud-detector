import { FraudAlert } from '../../domain/alert/fraud-alert';

/** Publicação de alertas no barramento de saída (ADR-01: SNS FIFO). */
export interface EventBus {
  publishAlert(alert: FraudAlert, traceparent?: string): Promise<void>;
}
export const EVENT_BUS = Symbol('EventBus');
