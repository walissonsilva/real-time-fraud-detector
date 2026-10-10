import { loadConfig } from './config.module';

const KEYS = [
  'NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'RULES_SOURCE', 'RULES_CONFIG_PATH',
  'APPCONFIG_APPLICATION', 'APPCONFIG_ENVIRONMENT', 'APPCONFIG_PROFILE',
  'RULES_POLL_INTERVAL_MS', 'RULES_STARTUP_TIMEOUT_MS', 'RULES_REQUEST_TIMEOUT_MS', 'RULES_METRICS_LOG',
] as const;

describe('loadConfig: fonte das regras (FR-018)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    process.env.DATABASE_URL = 'postgres://x';
    process.env.REDIS_URL = 'redis://x';
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('RULES_SOURCE ausente em produção resolve appconfig', () => {
    process.env.NODE_ENV = 'production';
    process.env.APPCONFIG_APPLICATION = 'a';
    process.env.APPCONFIG_ENVIRONMENT = 'e';
    process.env.APPCONFIG_PROFILE = 'p';
    expect(loadConfig().rulesSource).toBe('appconfig');
  });

  it('RULES_SOURCE ausente fora de produção resolve file e não exige APPCONFIG_*', () => {
    process.env.NODE_ENV = 'development';
    const config = loadConfig();
    expect(config.rulesSource).toBe('file');
    expect(config.appconfig).toEqual({ application: '', environment: '', profile: '' });
    delete process.env.NODE_ENV;
    expect(loadConfig().rulesSource).toBe('file');
  });

  it('valores explícitos são respeitados, inclusive file em produção', () => {
    process.env.NODE_ENV = 'production';
    process.env.RULES_SOURCE = 'file';
    expect(loadConfig().rulesSource).toBe('file');
    process.env.NODE_ENV = 'development';
    process.env.RULES_SOURCE = 'appconfig';
    process.env.APPCONFIG_APPLICATION = 'a';
    process.env.APPCONFIG_ENVIRONMENT = 'e';
    process.env.APPCONFIG_PROFILE = 'p';
    expect(loadConfig().rulesSource).toBe('appconfig');
  });

  it('valor desconhecido lança erro', () => {
    process.env.RULES_SOURCE = 's3';
    expect(() => loadConfig()).toThrow(/RULES_SOURCE/);
  });

  it.each(['APPCONFIG_APPLICATION', 'APPCONFIG_ENVIRONMENT', 'APPCONFIG_PROFILE'])(
    'appconfig sem %s lança erro citando só o nome da variável',
    (missing) => {
      process.env.RULES_SOURCE = 'appconfig';
      for (const k of ['APPCONFIG_APPLICATION', 'APPCONFIG_ENVIRONMENT', 'APPCONFIG_PROFILE']) {
        if (k !== missing) process.env[k] = 'valor-secreto-123';
      }
      expect.assertions(2);
      try {
        loadConfig();
      } catch (err) {
        expect((err as Error).message).toContain(missing);
        expect((err as Error).message).not.toContain('valor-secreto-123');
      }
    },
  );

  it('parâmetros de consulta têm padrão e podem ser ajustados', () => {
    expect(loadConfig().rules).toEqual({ pollIntervalMs: 20000, startupTimeoutMs: 45000, requestTimeoutMs: 5000, metricsLog: false });
    process.env.RULES_POLL_INTERVAL_MS = '30000';
    process.env.RULES_STARTUP_TIMEOUT_MS = '60000';
    process.env.RULES_REQUEST_TIMEOUT_MS = '3000';
    process.env.RULES_METRICS_LOG = 'true';
    expect(loadConfig().rules).toEqual({ pollIntervalMs: 30000, startupTimeoutMs: 60000, requestTimeoutMs: 3000, metricsLog: true });
  });
});
