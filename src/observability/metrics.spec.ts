import { InMemoryMetrics } from './metrics';

describe('InMemoryMetrics.counterTotal', () => {
  it('soma todas as combinações de rótulos do contador', () => {
    const m = new InMemoryMetrics();
    m.increment('deliveries_total', { channel: 'a', status: 'delivered' }, 2);
    m.increment('deliveries_total', { channel: 'b', status: 'dead_lettered' }, 1);
    m.increment('deliveries_total_other', undefined, 9);
    expect(m.counterTotal('deliveries_total')).toBe(3);
  });

  it('com where, soma só as combinações que contêm os rótulos pedidos', () => {
    const m = new InMemoryMetrics();
    m.increment('deliveries_total', { channel: 'a', status: 'delivered' }, 2);
    m.increment('deliveries_total', { channel: 'b', status: 'delivered' }, 3);
    m.increment('deliveries_total', { channel: 'b', status: 'dead_lettered' }, 1);
    expect(m.counterTotal('deliveries_total', { status: 'delivered' })).toBe(5);
    expect(m.counterTotal('deliveries_total', { channel: 'b', status: 'delivered' })).toBe(3);
    expect(m.counterTotal('deliveries_total', { status: 'deliv' })).toBe(0);
  });
});
