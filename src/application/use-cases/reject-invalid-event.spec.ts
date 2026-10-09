import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { DlqPublisher } from '../ports/dlq-publisher.port';
import { Logger, Metrics } from '../ports/observability.port';
import { RejectionReason } from '../ports/event-validator.port';
import { DlqMessage } from '../../domain/dlq/dlq-message';
import { RejectInvalidEvent } from './reject-invalid-event';

const schema = JSON.parse(readFileSync(join(__dirname, '../../../docs/contratos/dlq-message.v1.schema.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validateDlq = ajv.compile(schema);

const SECRET_RAW = '{"transactionId":"tx-1","ipAddress":"203.0.113.7"';

function setup(publishError?: Error) {
  const published: { queue: string; message: DlqMessage }[] = [];
  const dlq: DlqPublisher = {
    publish: jest.fn(async (queue, message) => {
      if (publishError) throw publishError;
      published.push({ queue, message });
    }),
  };
  const lines: string[] = [];
  const logger: Logger = {
    info: (m, f) => lines.push(JSON.stringify([m, f])),
    warn: (m, f) => lines.push(JSON.stringify([m, f])),
    error: (m, f) => lines.push(JSON.stringify([m, f])),
  };
  const metrics: Metrics = { increment: jest.fn(), gauge: jest.fn(), observe: jest.fn() };
  const useCase = new RejectInvalidEvent({ dlq, dlqQueue: 'transactions-dlq', source: 'transactions', logger, metrics, newId: () => '00000000-0000-4000-8000-000000000001' });
  return { useCase, published, lines, metrics, dlq };
}

describe('RejectInvalidEvent', () => {
  it.each<[RejectionReason, string]>([
    ['DESERIALIZATION_ERROR', 'corpo não é JSON válido'],
    ['SCHEMA_INVALID', '/amount/minorUnits: minimum'],
    ['UNSUPPORTED_VERSION', '/schemaVersion: major não suportada'],
  ])('%s → DlqMessage INGEST_VALIDATION com original preservado', async (reasonCode, detail) => {
    const { useCase, published, metrics } = setup();
    await useCase.execute({ rawBody: SECRET_RAW, result: { ok: false, reasonCode, detail }, traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });

    expect(published).toHaveLength(1);
    const { queue, message } = published[0];
    expect(queue).toBe('transactions-dlq');
    expect(message).toMatchObject({ stage: 'INGEST_VALIDATION', reasonCode, reasonDetail: detail, attempts: 1 });
    expect(validateDlq(message)).toBe(true);
    // original preservado (corpo ilegível vai como base64 e é recuperável)
    expect(Buffer.from(message.original.payload as string, 'base64').toString('utf8')).toBe(SECRET_RAW);
    expect(metrics.increment).toHaveBeenCalledWith('events_rejected_total', { reason: reasonCode });
    expect(metrics.increment).toHaveBeenCalledWith('dlq_total', { stage: 'INGEST_VALIDATION' });
  });

  it('JSON válido porém inválido pelo schema preserva o objeto original', async () => {
    const { useCase, published } = setup();
    const raw = JSON.stringify({ transactionId: 'tx-9', amount: { minorUnits: -1 } });
    await useCase.execute({ rawBody: raw, result: { ok: false, reasonCode: 'SCHEMA_INVALID', detail: '/x: type' } });
    expect(published[0].message.original).toMatchObject({ encoding: 'json', payload: { transactionId: 'tx-9' } });
    expect(published[0].message.correlation).toEqual({ transactionId: 'tx-9' });
  });

  it('nenhum log nem rótulo contém o conteúdo da mensagem', async () => {
    const { useCase, lines } = setup();
    await useCase.execute({ rawBody: SECRET_RAW, result: { ok: false, reasonCode: 'DESERIALIZATION_ERROR', detail: 'corpo não é JSON válido' } });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain('203.0.113.7');
      expect(line).not.toContain('tx-1');
    }
  });

  it('falha ao publicar na DLQ propaga o erro (a mensagem não deve ser excluída)', async () => {
    const { useCase } = setup(new Error('sqs fora'));
    await expect(
      useCase.execute({ rawBody: '{}', result: { ok: false, reasonCode: 'SCHEMA_INVALID', detail: '/: required' } }),
    ).rejects.toThrow('sqs fora');
  });
});
