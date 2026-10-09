import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { FraudAlert } from './fraud-alert';
import { SnsEventBus } from './sns-event-bus';

const alert = {
  schemaVersion: '1.0',
  alertId: 'b4d1c1de-5a0f-4a58-9f4c-0d0c8b6c0e11',
  dedupeKey: 'a'.repeat(64),
  accountId: 'acc_1',
  publishedAt: '2026-10-08T10:00:00.000Z',
} as unknown as FraudAlert;

describe('SnsEventBus', () => {
  const make = (send: jest.Mock) =>
    new SnsEventBus({ send } as unknown as SNSClient, { snsAlertsTopic: 'alerts.fifo', snsPublishTimeoutMs: 200 });

  it('publica com grupo = accountId, dedupe = dedupeKey e atributos', async () => {
    const calls: PublishCommand[] = [];
    const send = jest.fn(async (cmd: unknown) => {
      if (cmd instanceof PublishCommand) {
        calls.push(cmd);
        return {};
      }
      return { TopicArn: 'arn:aws:sns:us-east-1:000000000000:alerts.fifo' };
    });
    await make(send).publishAlert(alert, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

    expect(calls).toHaveLength(1);
    const input = calls[0].input;
    expect(input.TopicArn).toContain('alerts.fifo');
    expect(input.MessageGroupId).toBe('acc_1');
    expect(input.MessageDeduplicationId).toBe('a'.repeat(64));
    expect(JSON.parse(input.Message!)).toMatchObject({ alertId: alert.alertId });
    expect(input.MessageAttributes).toMatchObject({
      'schema-version': { StringValue: '1.0' },
      'message-id': { StringValue: alert.alertId },
      traceparent: { StringValue: expect.stringContaining('4bf92f35') },
    });
  });

  it('retenta falhas transitórias e propaga erro ao esgotar', async () => {
    const send = jest.fn(async (cmd: unknown) => {
      if (cmd instanceof PublishCommand) throw new Error('indisponível');
      return { TopicArn: 'arn' };
    });
    await expect(make(send).publishAlert(alert)).rejects.toThrow('indisponível');
    expect(send.mock.calls.filter(([c]) => c instanceof PublishCommand)).toHaveLength(3);
  });

  it('recusa alerta sem publishedAt', async () => {
    await expect(make(jest.fn()).publishAlert({ ...alert, publishedAt: undefined })).rejects.toThrow(/publishedAt/);
  });
});
