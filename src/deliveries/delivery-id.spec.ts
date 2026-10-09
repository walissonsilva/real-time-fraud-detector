import { createHash } from 'node:crypto';
import { deliveryIdOf } from './delivery-id';

describe('deliveryIdOf', () => {
  const alertId = 'b4d1c1de-5a0f-4a58-9f4c-0d0c8b6c0e11';

  it('é sha256("alert-delivery:v1:" + alertId + ":" + canal), estável entre chamadas', () => {
    const expected = createHash('sha256').update(`alert-delivery:v1:${alertId}:PUSH`).digest('hex');
    expect(deliveryIdOf(alertId, 'PUSH')).toBe(expected);
    expect(deliveryIdOf(alertId, 'PUSH')).toBe(expected);
  });

  it('bate com os exemplos do contrato', () => {
    expect(deliveryIdOf(alertId, 'PUSH')).toBe('0904a074c93da29e5b7aa15991fc8663dd844cc84b3fa92a7640d8766972ccf9');
    expect(deliveryIdOf(alertId, 'ANTIFRAUD_QUEUE')).toBe('52db168613f87aeb88b1563504a21f24b50d6fcb44d145f81da057b0988d6873');
  });

  it('muda por canal e por alerta', () => {
    expect(deliveryIdOf(alertId, 'PUSH')).not.toBe(deliveryIdOf(alertId, 'SMS'));
    expect(deliveryIdOf(alertId, 'PUSH')).not.toBe(deliveryIdOf('outro', 'PUSH'));
  });
});
