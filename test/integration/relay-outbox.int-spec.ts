import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AlertRepository } from '../../src/alerts/alert.repository';
import { newPool, pendingAlert } from './support';

describe('relay do outbox: claim concorrente e backoff (requer infra:up e migrate)', () => {
  const runId = randomUUID().slice(0, 8);
  const pool: Pool = newPool();
  const repo = new AlertRepository(pool);
  const alertIds: string[] = [];

  const seed = async (n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const alert = pendingAlert(runId);
      expect(await repo.saveWithOutbox(alert, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBe(true);
      ids.push(alert.alertId);
    }
    alertIds.push(...ids);
    return ids;
  };

  const mine = (entries: { alert: { alertId: string } }[]) => entries.map((e) => e.alert.alertId).filter((id) => alertIds.includes(id));

  afterAll(async () => {
    await pool.query('DELETE FROM outbox WHERE alert_id = ANY($1::uuid[])', [alertIds]);
    await pool.query('DELETE FROM alerts WHERE alert_id = ANY($1::uuid[])', [alertIds]);
    await pool.end();
  });

  it('duas instâncias concorrentes não reivindicam a mesma linha (SKIP LOCKED + lease)', async () => {
    const ids = await seed(20);
    const [a, b] = await Promise.all([
      repo.claimPendingOutbox(1000, 0, 60_000),
      new AlertRepository(pool).claimPendingOutbox(1000, 0, 60_000),
    ]);
    const claimedA = mine(a);
    const claimedB = mine(b);
    expect(claimedA.filter((id) => claimedB.includes(id))).toEqual([]);
    expect([...claimedA, ...claimedB].sort()).toEqual([...ids].sort());
    // payload e traceparent vêm do outbox
    expect([...a, ...b].find((e) => e.alert.alertId === ids[0])?.traceparent).toContain('4bf92f35');
  });

  it('linhas com lease vigente não são reivindicadas de novo; após o lease voltam', async () => {
    const [id] = await seed(1);
    expect(mine(await repo.claimPendingOutbox(1000, 0, 60_000))).toEqual([id]);
    expect(mine(await repo.claimPendingOutbox(1000, 0, 60_000))).toEqual([]);
    await pool.query('UPDATE outbox SET next_attempt_at = now() WHERE alert_id = $1', [id]);
    expect(mine(await repo.claimPendingOutbox(1000, 0, 60_000))).toEqual([id]);
  });

  it('respeita a idade mínima (minAge) e ignora publicadas', async () => {
    const [young, published] = await seed(2);
    await repo.markPublished(published, new Date());
    expect(mine(await repo.claimPendingOutbox(1000, 60_000, 60_000))).toEqual([]);
    const claimed = mine(await repo.claimPendingOutbox(1000, 0, 60_000));
    expect(claimed).toContain(young);
    expect(claimed).not.toContain(published);
  });

  it('recordPublishFailure incrementa attempts, guarda o erro e aplica backoff crescente', async () => {
    const [id] = await seed(1);
    const read = async () =>
      (await pool.query('SELECT attempts, last_error, EXTRACT(EPOCH FROM (next_attempt_at - now())) AS wait FROM outbox WHERE alert_id = $1', [id])).rows[0];

    await repo.recordPublishFailure(id, 'ServiceUnavailable');
    let row = await read();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('ServiceUnavailable');
    const firstWait = Number(row.wait);
    expect(firstWait).toBeGreaterThan(0);
    expect(firstWait).toBeLessThanOrEqual(1.1);

    await repo.recordPublishFailure(id, 'Timeout');
    row = await read();
    expect(row.attempts).toBe(2);
    expect(Number(row.wait)).toBeGreaterThan(firstWait);

    // em backoff: não é reivindicada
    expect(mine(await repo.claimPendingOutbox(1000, 0, 60_000))).not.toContain(id);
  });

  it('markPublished é idempotente e preserva o primeiro instante', async () => {
    const [id] = await seed(1);
    const first = new Date('2026-10-08T10:00:00.000Z');
    await repo.markPublished(id, first);
    await repo.markPublished(id, new Date('2026-10-08T11:00:00.000Z'));
    const { rows } = await pool.query('SELECT published_at FROM outbox WHERE alert_id = $1', [id]);
    expect(new Date(rows[0].published_at).toISOString()).toBe(first.toISOString());
  });

  it('findPendingByDedupeKey só devolve linhas pendentes', async () => {
    const alert = pendingAlert(runId);
    await repo.saveWithOutbox(alert);
    alertIds.push(alert.alertId);
    expect((await repo.findPendingByDedupeKey(alert.dedupeKey))?.alert.alertId).toBe(alert.alertId);
    await repo.markPublished(alert.alertId, new Date());
    expect(await repo.findPendingByDedupeKey(alert.dedupeKey)).toBeNull();
  });
});
