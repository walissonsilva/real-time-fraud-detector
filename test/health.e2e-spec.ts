import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('health (requer `npm run infra:up`)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres://fraud:fraud@localhost:55432/fraud';
    process.env.REDIS_URL ??= 'redis://localhost:6379';
    process.env.CONSUMERS_ENABLED = 'false'; // health não precisa dos consumidores
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });
  afterAll(async () => app.close());

  it('live', () => request(app.getHttpServer()).get('/health/live').expect(200));
  it('ready com postgres e redis no ar', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.checks).toEqual({ postgres: 'up', redis: 'up' });
  });
  it('metrics expõe outbox_pending e a idade da linha mais antiga', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(res.text).toMatch(/^outbox_pending \d+$/m);
    expect(res.text).toMatch(/^outbox_oldest_pending_age_ms \d+$/m);
  });
});
