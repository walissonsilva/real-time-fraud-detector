import { Global, Module } from '@nestjs/common';

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

export function loadConfig(): AppConfig {
  return {
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
  };
}

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: loadConfig }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
