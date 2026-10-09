export type LogFields = Readonly<Record<string, unknown>>;

/** Log estruturado. Implementações MUST redigir PII e segredos (FR-009, FR-027). */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
export const LOGGER = Symbol('Logger');

export type MetricLabels = Readonly<Record<string, string>>;

export interface Metrics {
  increment(name: string, labels?: MetricLabels, by?: number): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
  observe(name: string, value: number, labels?: MetricLabels): void;
}
export const METRICS = Symbol('Metrics');
