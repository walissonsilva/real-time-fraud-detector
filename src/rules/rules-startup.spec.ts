import { buildRulesModule, appConfig } from './testing/rules-module.helpers';

describe('partida com o AppConfig (FR-010)', () => {
  it('sem configuração obtida até o prazo, a criação do módulo de regras rejeita: o serviço não chega ao listen', async () => {
    const send = jest.fn(async () => {
      throw Object.assign(new Error('InternalServerException'), { name: 'InternalServerException' });
    });
    await expect(buildRulesModule(appConfig({ rulesSource: 'appconfig' }), send)).rejects.toThrow(/regras/);
    expect(send).toHaveBeenCalled();
  });

  it('o erro de partida não expõe token nem conteúdo', async () => {
    const send = jest.fn(async () => {
      throw Object.assign(new Error('SEGREDO-TOKEN'), { name: 'ThrottlingException' });
    });
    const err = await buildRulesModule(appConfig({ rulesSource: 'appconfig' }), send).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('SEGREDO-TOKEN');
  });
});
