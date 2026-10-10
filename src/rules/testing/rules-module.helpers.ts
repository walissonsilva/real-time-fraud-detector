import { join } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { APPCONFIGDATA_CLIENT } from '../../aws/aws-clients.module';
import { APP_CONFIG, AppConfig } from '../../config/config.module';
import { JsonLogger } from '../../observability/logger';
import { RulesModule } from '../rules.module';

const root = join(__dirname, '../../..');

export function appConfig(patch: Partial<AppConfig> = {}): AppConfig {
  return {
    aws: { region: 'us-east-1' },
    rulesConfigPath: join(root, 'config/rules.json'),
    rulesSource: 'file',
    appconfig: { application: 'app-1', environment: 'env-1', profile: 'prof-1' },
    rules: { pollIntervalMs: 20000, startupTimeoutMs: 300, requestTimeoutMs: 100, metricsLog: false },
    ...patch,
  } as AppConfig;
}

/** SDK falso do AppConfig: `send` recebe os comandos e devolve o que o teste define. */
export function sdkStub(send: jest.Mock) {
  return { send, destroy: jest.fn() };
}

export async function buildRulesModule(config: AppConfig, send: jest.Mock): Promise<TestingModule> {
  @Global()
  @Module({
    providers: [{ provide: APP_CONFIG, useValue: config }],
    exports: [APP_CONFIG],
  })
  class TestConfigModule {}

  return Test.createTestingModule({ imports: [TestConfigModule, RulesModule] })
    .overrideProvider(APPCONFIGDATA_CLIENT)
    .useValue(sdkStub(send))
    .overrideProvider(JsonLogger)
    .useValue(new JsonLogger(() => undefined))
    .compile();
}
