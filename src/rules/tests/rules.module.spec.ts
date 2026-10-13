import fs, { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StartConfigurationSessionCommand } from '@aws-sdk/client-appconfigdata';
import { AppConfigRuleRepository } from '../appconfig-rule.repository';
import { RULE_REPOSITORY, RuleRepository } from '../rule-source';
import { appConfig, buildRulesModule } from './rules-module.helpers';
import { StaticRuleRepository } from '../static-rule.repository';

const root = join(__dirname, '../../..');
const rulesJson = readFileSync(join(root, 'config/rules.json'), 'utf8');

const okSdk = () =>
  jest.fn(async (cmd: unknown) =>
    cmd instanceof StartConfigurationSessionCommand
      ? { InitialConfigurationToken: 'tok-0' }
      : { Configuration: new TextEncoder().encode(rulesJson), NextPollConfigurationToken: 'tok-1', VersionLabel: '20261010120000' },
  );

describe('RulesModule: fonte das regras (FR-011, FR-018)', () => {
  it('rulesSource=file: expõe um StaticRuleRepository carregado de config/rules.json e não usa o AppConfig', async () => {
    const send = jest.fn();
    const spy = jest.spyOn(fs, 'readFileSync');
    const moduleRef = await buildRulesModule(appConfig({ rulesSource: 'file' }), send);
    // controle do espião: aqui o arquivo é lido; no teste do AppConfig, abaixo, não pode ser
    expect(spy.mock.calls.some(([p]) => String(p).endsWith('config/rules.json'))).toBe(true);
    spy.mockRestore();
    const repo = moduleRef.get<RuleRepository>(RULE_REPOSITORY);
    expect(repo).toBeInstanceOf(StaticRuleRepository);
    expect((await repo.loadActiveSnapshot()).rules).toHaveLength(4);
    expect(send).not.toHaveBeenCalled();
    await moduleRef.close();
  });

  it('rulesSource=appconfig: usa o AppConfig e NÃO lê o arquivo de regras, mesmo que ele exista', async () => {
    const spy = jest.spyOn(fs, 'readFileSync');
    const rulesPath = join(root, 'config/rules.json');
    const moduleRef = await buildRulesModule(appConfig({ rulesSource: 'appconfig', rulesConfigPath: rulesPath }), okSdk());
    try {
      const repo = moduleRef.get<RuleRepository>(RULE_REPOSITORY);
      expect(repo).toBeInstanceOf(AppConfigRuleRepository);
      expect(await repo.currentRevision()).toBe(20261010120000);
      expect(spy.mock.calls.some(([p]) => String(p).endsWith('config/rules.json'))).toBe(false);
    } finally {
      spy.mockRestore();
      await moduleRef.close();
    }
  });

  it('rulesSource=appconfig com RULES_CONFIG_PATH inexistente sobe normalmente (o caminho é ignorado)', async () => {
    const moduleRef = await buildRulesModule(appConfig({ rulesSource: 'appconfig', rulesConfigPath: '/nao/existe.json' }), okSdk());
    expect(await moduleRef.get<RuleRepository>(RULE_REPOSITORY).currentRevision()).toBe(20261010120000);
    await moduleRef.close();
  });
});
