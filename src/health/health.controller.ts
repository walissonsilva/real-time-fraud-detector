import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/pg-pool.token';
import { REDIS } from '../cache/redis.module';

@Controller()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: o processo está de pé. Não toca dependências. */
  @Get('health/live')
  @HttpCode(200)
  live() {
    return { status: 'ok' };
  }

  /** Readiness: dependências críticas (banco) respondem. Redis só afeta a fase 2. */
  @Get('health/ready')
  async ready() {
    const checks: Record<string, 'up' | 'down'> = { postgres: 'down', redis: 'down' };
    await this.pool.query('SELECT 1').then(() => (checks.postgres = 'up')).catch(() => undefined);
    await this.redis.ping().then(() => (checks.redis = 'up')).catch(() => undefined);
    if (checks.postgres !== 'up') throw new ServiceUnavailableException({ status: 'unavailable', checks });
    return { status: 'ok', checks };
  }
}
