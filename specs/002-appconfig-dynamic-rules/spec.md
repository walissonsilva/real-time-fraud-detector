# Feature Specification: Regras de Decisão Dinâmicas via AppConfig

**Feature Branch**: `002-appconfig-dynamic-rules`

**Created**: 2026-10-10

**Status**: Draft

**Input**: User description: "Gerenciar as regras de decisão de transação suspeita de forma dinâmica, sem redeploy, usando o AWS AppConfig como fonte das regras."

## Contexto

O desafio técnico exige "extensibilidade das regras sem necessidade de redeploy". Hoje as regras são lidas de um arquivo (`config/rules.json`) uma única vez, na inicialização, e ficam num conjunto imutável em memória. Qualquer mudança exige rebuild e redeploy, o que contraria o requisito. O ambiente já está na AWS, e o AWS AppConfig foi escolhido como fonte das regras por oferecer versões, rollout gradual, rollback e validação prontos.

## Clarifications

### Session 2026-10-10

- Q: Qual a estratégia padrão de rollout das regras? → A: Gradual curto como padrão (cerca de 10 min no total, com observação final de poucos minutos e rollback automático por alarme ativo); rollout imediato permitido por deployment, em urgências, sem janela de observação.
- Q: Que alarmes disparam o rollback automático? → A: Saúde do processamento (mensagens na DLQ e atraso da fila de transações), falhas de refresh das instâncias e taxa de alertas fora da faixa esperada em relação à linha de base (pico ou queda brusca). A latência de alerta ≤ 500 ms não é monitor de rollback; é verificada no teste de carga.
- Q: De onde vem o identificador de revisão usado em métricas, logs e alarmes? → A: De um rótulo de versão numérico e monotônico definido na publicação (a API de dados do AppConfig devolve o rótulo, não o número da versão; ajuste feito no plano, ver research D-03); o campo `revision` do documento só vale na fonte por arquivo (dev).
- Q: Quem pode publicar e implantar regras? → A: Um perfil de permissão dedicado a operadores de fraude, separado do perfil de deploy de código e da identidade das instâncias; toda ação auditada.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Alterar uma regra sem redeploy (Priority: P1)

Um operador de fraude precisa ajustar uma regra em produção (por exemplo, baixar o limite de valor alto ou adicionar um país de risco). Ele publica uma nova versão do documento de regras e, sem reiniciar nem reimplantar nada, todas as instâncias em execução passam a avaliar as transações com as regras novas.

**Why this priority**: É o requisito central do desafio ("extensibilidade das regras sem redeploy") e hoje não é atendido. Sem esta história, a feature não entrega valor.

**Independent Test**: Com o serviço em execução, publicar uma versão do documento com um limite diferente e verificar que, dentro do prazo esperado, transações antes aceitas passam a gerar alerta (ou o contrário), sem reiniciar nenhuma instância.

**Acceptance Scenarios**:

1. **Given** instâncias em execução com a revisão N das regras, **When** o operador publica e implanta a revisão N+1 válida, **Then** todas as instâncias passam a avaliar com a revisão N+1 em até cerca de 30 s após o fim do rollout, sem reinício.
2. **Given** uma regra nova (`ruleId` inédito) na revisão N+1, **When** uma transação a satisfaz, **Then** o alerta é gerado com essa regra.
3. **Given** a troca de revisão em andamento, **When** transações estão sendo processadas, **Then** cada transação é avaliada por inteiro com a revisão N ou com a N+1, nunca com um conjunto misto.

---

### User Story 2 - Reverter para a versão anterior das regras (Priority: P1)

Depois de publicar uma alteração, o operador percebe que ela causa falsos positivos (ou deixa de pegar fraude). Ele reverte para a versão anterior das regras sem redeploy, com o mesmo efeito de uma publicação normal. Se um alarme operacional disparar durante um rollout gradual, a reversão acontece automaticamente.

**Why this priority**: Rollback é parte explícita do requisito e é o que torna seguro mudar regras em produção.

**Independent Test**: Implantar a revisão N+1, depois apontar o deployment de volta para a revisão N e verificar que as instâncias voltam a avaliar com N. Separadamente, disparar o alarme configurado durante um rollout e verificar a reversão automática.

**Acceptance Scenarios**:

1. **Given** a revisão N+1 ativa, **When** o operador implanta novamente a revisão N, **Then** todas as instâncias voltam a avaliar com N, com o mesmo prazo da publicação normal.
2. **Given** um rollout gradual da revisão N+1 em andamento, **When** um dos alarmes associados (saúde do processamento, falhas de refresh ou taxa de alertas fora da faixa) dispara, **Then** o rollout é revertido automaticamente para a revisão anterior.

---

### User Story 3 - Documento inválido nunca entra em produção (Priority: P1)

Um operador publica, por engano, um documento com uma regra malformada (fora do contrato, expressão inválida, regra dependente de janela na fase 1, duplicidade de `ruleId` ou nenhuma regra ativa). O documento é barrado antes de chegar às instâncias, ou, se chegar, é rejeitado por elas, e as regras ativas continuam inalteradas.

**Why this priority**: Sem validação, a flexibilidade de mudar regras ao vivo vira um risco de indisponibilidade ou de deixar fraude passar.

**Independent Test**: Publicar documentos inválidos de cada categoria e verificar que as instâncias continuam com a revisão anterior, registram o motivo e seguem processando.

**Acceptance Scenarios**:

1. **Given** um documento fora do contrato Rule v1, **When** o operador tenta publicá-lo, **Then** a publicação é rejeitada e nenhuma instância o recebe.
2. **Given** um documento que passa no contrato mas falha na validação do motor (sintaxe, custo, regra dependente de janela, `ruleId` duplicado, nenhuma regra ativa), **When** chega a uma instância, **Then** a instância o rejeita, mantém a revisão anterior e registra o `ruleId` e a regra violada, sem valores sensíveis.
3. **Given** um documento inválido rejeitado, **When** transações continuam chegando, **Then** o processamento e a latência não são afetados.

---

### User Story 4 - Continuar operando quando o serviço de configuração falha (Priority: P2)

O serviço de configuração (AppConfig) fica indisponível durante a operação. As instâncias em execução seguem processando transações com a última versão válida das regras, sem interrupção. Uma instância nova que não consiga obter a configuração na partida não sobe, em vez de operar com regras desconhecidas ou desatualizadas.

**Why this priority**: Resiliência é exigência do desafio. A decisão consciente é preferir nunca operar com regras erradas ou antigas sem aviso, aceitando que instâncias novas não subam durante a queda.

**Independent Test**: (a) Bloquear o acesso ao serviço de configuração com a aplicação em execução e verificar que o processamento continua com a última revisão. (b) Subir uma instância nova com o acesso bloqueado e verificar que ela falha após as tentativas, sem ficar no ar.

**Acceptance Scenarios**:

1. **Given** uma instância em execução com a revisão N, **When** o serviço de configuração fica inacessível, **Then** a instância continua avaliando com N, registra cada falha e não degrada o processamento.
2. **Given** uma instância iniciando, **When** não consegue obter a configuração após as tentativas com espera crescente (cerca de 30 a 60 s), **Then** o serviço não inicia e registra um erro claro.
3. **Given** uma instância iniciando, **When** o serviço de configuração responde só na terceira tentativa, **Then** a instância sobe normalmente com a revisão obtida.
4. **Given** a instância em execução, **When** o serviço responde "sem mudança", **Then** o conjunto ativo é mantido (resposta vazia nunca significa "sem regras").
5. **Given** a sessão de consulta expirada, **When** a próxima consulta ocorre, **Then** a instância reabre a sessão automaticamente e segue.

---

### User Story 5 - Enxergar defasagem e rollout travado (Priority: P2)

Um engenheiro de SRE precisa saber qual revisão cada instância está usando, há quanto tempo ela não consegue atualizar e se alguma instância ficou para trás, para detectar rollout travado ou falha no serviço de configuração antes que vire incidente.

**Why this priority**: Manter a última versão válida só é seguro se for possível ver quando ela está velha. Sem isso, a falha seria silenciosa.

**Independent Test**: Forçar falhas de consulta e uma instância em revisão diferente e verificar que as métricas refletem a situação e que os alarmes disparam.

**Acceptance Scenarios**:

1. **Given** instâncias em execução, **When** o SRE consulta as métricas, **Then** vê a revisão ativa por instância, a idade do último refresh bem-sucedido e o total de falhas de refresh.
2. **Given** a idade do último refresh acima do limite (alinhado ao SLO de frescor das regras, até 30 s), **When** o limite é ultrapassado, **Then** um alarme dispara.
3. **Given** instâncias em revisões diferentes por tempo prolongado, **When** o limite de tolerância é ultrapassado, **Then** um alarme de rollout travado dispara.

---

### User Story 6 - Desenvolver e testar localmente sem a AWS (Priority: P3)

Uma pessoa desenvolvedora sobe o ambiente local (docker-compose) e roda os testes sem depender do AppConfig, usando o arquivo `config/rules.json` como fonte. Em produção, o arquivo não é lido.

**Why this priority**: Mantém o ciclo de desenvolvimento simples e os testes determinísticos, sem aumentar a superfície de risco em produção.

**Independent Test**: Com a fonte configurada como arquivo, subir a aplicação localmente e confirmar que as regras vêm do arquivo; com a fonte configurada como AppConfig (padrão de produção), confirmar que o arquivo é ignorado.

**Acceptance Scenarios**:

1. **Given** a fonte configurada como arquivo, **When** a aplicação inicia, **Then** carrega e valida o `config/rules.json` como hoje.
2. **Given** a fonte configurada como AppConfig, **When** a aplicação inicia, **Then** não lê o arquivo embutido e usa somente o AppConfig.
3. **Given** nenhuma configuração explícita em ambiente de produção, **When** a aplicação inicia, **Then** a fonte padrão é o AppConfig.

---

### Edge Cases

- **Resposta vazia do serviço de configuração**: significa "sem mudança", nunca "lista vazia de regras".
- **Documento válido no contrato, mas sem nenhuma regra ativa**: rejeitado; o conjunto atual permanece.
- **Documento com `ruleId` duplicado ou regra dependente de janela (fase 1)**: rejeitado; o conjunto atual permanece.
- **Falha intermitente de consulta (rede, indisponibilidade)**: mantém o conjunto atual, registra a falha e tenta de novo no próximo ciclo.
- **Sessão de consulta expirada**: reaberta automaticamente.
- **Instância nova durante uma queda do serviço de configuração**: não sobe após as tentativas; as instâncias antigas seguem atendendo e, num deploy, o orquestrador reverte.
- **Autoscaling coincidindo com a queda**: instâncias novas não sobem; é um risco aceito e documentado.
- **Duas revisões em trânsito durante o rollout**: instâncias podem estar temporariamente em revisões diferentes, mas cada transação é avaliada com um único conjunto.
- **Logs de erro de regra**: citam apenas `ruleId` e regra violada, nunca valores de transação ou dados pessoais.
- **Reversão para uma revisão já usada antes**: tratada como qualquer outra implantação.
- **Documento sem campo `revision` ou com valor repetido**: sem efeito em produção, porque o identificador de revisão vem do rótulo de versão definido na publicação, não do conteúdo do documento. Conteúdo sem rótulo numérico é rejeitado.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: O sistema MUST obter as regras de decisão de um serviço de configuração gerenciado (AWS AppConfig) em produção, e permitir cadastrar e alterar regras sem redeploy nem reinício das instâncias.
- **FR-002**: O sistema MUST consultar o serviço de configuração periodicamente, a cada 15 a 30 s, e aplicar uma nova revisão automaticamente quando ela existir.
- **FR-003**: O sistema MUST permitir o rollback para uma revisão anterior sem redeploy, com o mesmo prazo de propagação de uma publicação normal.
- **FR-004**: O sistema MUST suportar rollback automático quando um alarme operacional associado disparar durante um rollout gradual. Os alarmes associados MUST cobrir a saúde do processamento (mensagens na DLQ e atraso da fila de transações), as falhas de refresh das instâncias e a taxa de alertas fora da faixa esperada em relação à linha de base (pico ou queda brusca).
- **FR-005**: O documento de regras MUST ser validado contra o contrato Rule v1 no momento da publicação, de modo que um documento fora do contrato não seja distribuído.
- **FR-006**: Cada instância MUST validar e compilar o conjunto recebido antes de ativá-lo, com as mesmas regras de hoje: contrato, sintaxe, custo, rejeição de regras dependentes de janela na fase 1, ao menos uma regra `ACTIVE` e `ruleId` sem duplicidade.
- **FR-007**: Uma regra ou documento inválido MUST NOT ser ativado; o conjunto atual permanece em uso.
- **FR-008**: A troca de conjunto MUST ser atômica: uma transação é avaliada inteiramente com um único conjunto de regras, nunca com um conjunto misto.
- **FR-009**: O processamento de transações MUST NOT realizar chamadas de rede ao serviço de configuração; as regras ativas ficam em memória e a latência de alerta (≤ 500 ms) não pode ser afetada.
- **FR-010**: Na partida, a instância MUST tentar obter a configuração com novas tentativas e espera crescente (cerca de 30 a 60 s no total); se não conseguir, MUST NOT iniciar e MUST registrar um erro claro.
- **FR-011**: Em produção, o sistema MUST NOT recorrer ao arquivo de regras embutido na imagem como alternativa quando o serviço de configuração falhar.
- **FR-012**: Em execução, diante de falha de consulta, indisponibilidade do serviço ou documento inválido, a instância MUST manter o último conjunto válido, registrar o motivo e continuar processando.
- **FR-013**: O sistema MUST tratar uma resposta vazia do serviço de configuração como "sem mudança", nunca como lista vazia de regras.
- **FR-014**: O sistema MUST reabrir automaticamente a sessão de consulta quando ela expirar.
- **FR-015**: Registros de erro de regra MUST citar apenas `ruleId` e a regra violada, nunca valores de transação ou dados pessoais.
- **FR-016**: O sistema MUST expor, por instância, a revisão ativa (rótulo de versão numérico definido na publicação), a idade do último refresh bem-sucedido e o total de falhas de refresh.
- **FR-017**: O sistema MUST ter alarme para idade do último refresh acima do limite (alinhado ao SLO de frescor das regras, até 30 s) e alarme para instâncias em revisões diferentes por tempo prolongado.
- **FR-018**: A fonte das regras MUST ser selecionável por configuração entre arquivo e AppConfig; em desenvolvimento, testes e docker-compose vale o arquivo `config/rules.json`; em produção o padrão é o AppConfig e o arquivo não é lido.
- **FR-019**: A infraestrutura do AppConfig MUST ser provisionada como código (aplicação, ambiente, perfil de configuração com validador de contrato e estratégias de deployment); a primeira revisão de regras é semeada por script depois do provisionamento, e até lá as instâncias não sobem (fail-fast), com permissões mínimas para a identidade das instâncias lerem a configuração.
- **FR-020**: Os alarmes e as métricas desta feature MUST ser integrados ao monitoramento existente.
- **FR-021**: O comportamento de avaliação das regras (resultado para uma mesma transação e um mesmo conjunto de regras) MUST ser idêntico ao atual, qualquer que seja a fonte.
- **FR-022**: A estratégia padrão de deployment de regras MUST ser gradual e curta (cerca de 10 min no total, com observação final de poucos minutos), com o rollback automático por alarme ativo durante a janela. Um deployment imediato (sem janela de observação) MUST ser possível por escolha explícita do operador, para urgências.
- **FR-023**: Publicar e implantar regras MUST exigir um perfil de permissão dedicado a operadores de fraude, distinto do perfil de deploy de código e da identidade das instâncias (que só podem ler a configuração). Toda publicação e todo deployment MUST ficar registrado para auditoria (quem, quando e qual revisão).

### Key Entities *(include if feature involves data)*

- **Documento de regras**: conjunto versionado de regras no contrato Rule v1; é o que o operador publica.
- **Revisão**: uma versão publicada e imutável do documento de regras, identificada por um rótulo de versão numérico e monotônico definido na publicação (na fonte por arquivo, pelo campo `revision` do documento); pode ser implantada ou revertida.
- **Conjunto ativo (snapshot)**: as regras validadas e compiladas que uma instância usa em memória; trocado por inteiro, nunca editado parcialmente.
- **Deployment**: ato de tornar uma revisão ativa nas instâncias, com estratégia (gradual ou imediata) e, opcionalmente, alarme de reversão.
- **Estado de frescor da instância**: revisão ativa, momento do último refresh bem-sucedido e contagem de falhas, usados para métricas e alarmes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Alterar o limite de uma regra e vê-lo aplicado em 100% das instâncias em até cerca de 30 s após o fim do rollout, sem nenhum redeploy ou reinício.
- **SC-002**: Reverter para a revisão anterior produz o mesmo efeito, no mesmo prazo, sem redeploy.
- **SC-003**: Com o serviço de configuração totalmente inacessível durante a execução, 0 transações deixam de ser processadas por esse motivo e a latência de alerta permanece dentro de 500 ms.
- **SC-004**: 100% dos documentos inválidos testados (contrato, sintaxe, custo, janela, duplicidade, nenhuma regra ativa) são rejeitados sem alterar as regras ativas de nenhuma instância.
- **SC-005**: Uma instância nova sem acesso ao serviço de configuração não entra em operação em até cerca de 60 s e registra um erro claro.
- **SC-006**: Qualquer instância com defasagem acima do limite do SLO de frescor, ou em revisão diferente das demais por tempo prolongado, é sinalizada por alarme.
- **SC-007**: Nenhuma transação é avaliada com um conjunto misto de regras durante uma troca de revisão, comprovado por teste.
- **SC-008**: O ambiente local e os testes automatizados rodam sem acesso à AWS, usando o arquivo de regras.

## Assumptions

- O AWS AppConfig é a fonte de regras de produção por decisão do usuário e porque o ambiente já está na AWS; o documento de regras é o mesmo formato Rule v1 usado hoje.
- A identidade das instâncias em execução (role de tarefa) pode receber permissão de leitura do AppConfig.
- O intervalo de consulta fica entre 15 e 30 s, alinhado ao SLO de frescor; a duração do rollout (padrão gradual curto, ver FR-022) soma-se a esse tempo e pode ser trocada por um deployment imediato por escolha do operador.
- Durante uma queda do serviço de configuração, instâncias novas não sobem (inclusive por autoscaling); o risco é aceito para nunca operar com regras erradas ou desatualizadas sem aviso.
- Não há fluxo de rascunho e aprovação, nem interface gráfica de edição; o operador (com o perfil dedicado de FR-023) publica o documento pelo console ou pela linha de comando do provedor. A auditoria é limitada ao histórico de versões e deployments e ao registro de chamadas da conta.
- Regras que exijam campo ou função nova no motor continuam exigindo deploy; regras dependentes de janela (fase 2) continuam rejeitadas.
- O ambiente local não usa o AppConfig, que não é emulado de forma confiável localmente; o arquivo `config/rules.json` cobre dev e testes.
- Existe um limite de tolerância configurável para "revisões diferentes por tempo prolongado"; o valor inicial é 20 min (maior que o rollout de 10 min mais o *bake* de 5 min).
- **Alinhamento com a constituição**: o Princípio VI (v2.1.0) prevê regras alteradas em tempo de execução por uma fonte de configuração gerenciada (AWS AppConfig em produção), com validação prévia, troca atômica, fail-fast na partida, última versão válida em execução e sem fallback embutido em produção. Esta feature implementa exatamente esse princípio, sem desvio a justificar.
