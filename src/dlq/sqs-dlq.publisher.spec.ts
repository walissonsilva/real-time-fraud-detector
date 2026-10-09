import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { buildDlqMessage } from './dlq-message';
import { SqsDlqPublisher } from './sqs-dlq.publisher';

describe('SqsDlqPublisher', () => {
  const schema = JSON.parse(readFileSync(join(__dirname, '../../docs/contratos/dlq-message.v1.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  it('envia DlqMessage v1 válido preservando o original', async () => {
    const sent: SendMessageCommand[] = [];
    const sqs = {
      send: jest.fn(async (cmd: unknown) => {
        if (cmd instanceof SendMessageCommand) {
          sent.push(cmd);
          return {};
        }
        return { QueueUrl: 'http://localhost/000000000000/transactions-dlq' };
      }),
    } as unknown as SQSClient;
    const original = '{"transactionId":"tx-1"}';
    const message = buildDlqMessage(
      { stage: 'PERSISTENCE', reasonCode: 'MAX_RETRIES_EXCEEDED', attempts: 4, rawBody: original, source: 'transactions' },
      '6c1f3a52-0b1e-4c53-8d51-3f6f5a9e2b10',
    );

    await new SqsDlqPublisher(sqs).publish('transactions-dlq', message);

    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0].input.MessageBody!);
    expect(validate(body)).toBe(true);
    expect(body.original.payload).toEqual({ transactionId: 'tx-1' });
    expect(sent[0].input.MessageGroupId).toBeUndefined();
  });

  it('usa base64 quando o original não é JSON e grupo/dedup em filas FIFO', async () => {
    const sent: SendMessageCommand[] = [];
    const sqs = {
      send: jest.fn(async (cmd: unknown) => {
        if (cmd instanceof SendMessageCommand) {
          sent.push(cmd);
          return {};
        }
        return { QueueUrl: 'http://localhost/000000000000/x.fifo' };
      }),
    } as unknown as SQSClient;
    const message = buildDlqMessage(
      { stage: 'CHANNEL_DELIVERY', reasonCode: 'MAX_RETRIES_EXCEEDED', rawBody: '{truncado', correlation: { channel: 'PUSH' } },
      '6c1f3a52-0b1e-4c53-8d51-3f6f5a9e2b10',
    );
    await new SqsDlqPublisher(sqs).publish('x.fifo', message);
    const body = JSON.parse(sent[0].input.MessageBody!);
    expect(validate(body)).toBe(true);
    expect(body.original.encoding).toBe('base64');
    expect(Buffer.from(body.original.payload, 'base64').toString()).toBe('{truncado');
    expect(sent[0].input.MessageGroupId).toBe('PUSH');
    expect(sent[0].input.MessageDeduplicationId).toBe(message.dlqId);
  });
});
