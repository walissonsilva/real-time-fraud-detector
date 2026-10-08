import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config.module';

export const REDIS = Symbol('REDIS');

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onApplicationShutdown() {
    await this.redis.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new Redis(config.redisUrl, { maxRetriesPerRequest: 1, lazyConnect: false }),
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
