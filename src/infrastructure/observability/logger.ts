import { Logger, LogFields } from '../../application/ports/observability.port';

/** Campos que nunca podem aparecer em log: dados pessoais, identificadores em claro e segredos (FR-027). */
const SENSITIVE_KEYS = new Set(
  [
    'ipaddress', 'ip', 'geo', 'latitude', 'longitude', 'origin',
    'customerid', 'accountid', 'instrumenttoken', 'counterparty', 'merchant', 'devicehash', 'deviceidhash',
    'payload', 'original', 'body', 'amount', 'attributes',
    'password', 'secret', 'token', 'authorization', 'accesskeyid', 'secretaccesskey',
  ],
);

export const REDACTED = '[REDACTED]';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

/** Erros viram só nome + código: a mensagem pode ecoar conteúdo do evento. */
export function safeError(err: unknown): { errorName: string; errorCode?: string } {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return { errorName: err.name, ...(typeof code === 'string' ? { errorCode: code } : {}) };
  }
  return { errorName: 'UnknownError' };
}

export class JsonLogger implements Logger {
  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(line + '\n')) {}

  info(message: string, fields?: LogFields) {
    this.emit('info', message, fields);
  }
  warn(message: string, fields?: LogFields) {
    this.emit('warn', message, fields);
  }
  error(message: string, fields?: LogFields) {
    this.emit('error', message, fields);
  }

  private emit(level: string, message: string, fields?: LogFields) {
    this.write(JSON.stringify({ level, time: new Date().toISOString(), message, ...(redact(fields ?? {}) as object) }));
  }
}
