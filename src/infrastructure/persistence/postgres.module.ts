import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, AppConfig } from '../config/config.module';
import { ALERT_REPOSITORY } from '../../application/ports/alert-repository.port';
import { PostgresAlertRepository } from './postgres-alert.repository';
import { PG_POOL } from './pg-pool.token';

export { PG_POOL };


@Injectable()
class PoolLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown() {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new Pool({ connectionString: config.databaseUrl, max: 20 }),
    },
    PoolLifecycle,
    { provide: ALERT_REPOSITORY, useClass: PostgresAlertRepository },
  ],
  exports: [PG_POOL, ALERT_REPOSITORY],
})
export class PostgresModule {}
