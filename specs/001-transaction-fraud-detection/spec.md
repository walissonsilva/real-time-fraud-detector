# Feature Specification: Detecção de Fraude em Transações (Ingestão, Validação e Alertas)

**Feature Branch**: `001-transaction-fraud-detection`

**Created**: 2026-10-08

**Status**: Draft

**Input**: User description: "Eu quero criar uma feature que permita que um evento de transacao seja recebido e processado. Em caso de suspeita de fraude, deve gerar os alertas para os canais internos e externos. O evento deve ser lido do SQS, validado e, em caso de falha, deve ser rejeitado. As regras de decisão de fraude devem ser apenas stateless."

## Clarifications

### Session 2026-10-08

- Q: Qual o conjunto inicial de regras stateless? → A: Um conjunto pequeno e configurável de 2 a 4 regras de exemplo (valor alto, contraparte nova com valor alto, país do comerciante de risco, canal e tipo incomuns).
- Q: O que fazer quando um evento é reentregue e o alerta da transação já existe? → A: Não cria alerta novo, mas completa as entregas pendentes aos canais.
- Q: Quais tipos de evento são avaliados pelas regras? → A: Autorizadas e recusadas são avaliadas; estornos são validados e concluídos sem avaliação e sem alerta.
- Q: Como tratar falhas transitórias no processamento do evento? → A: Até 3 retentativas com espera crescente; ao esgotar, DLQ com motivo de tentativas esgotadas.
- Q: O que a mensagem ao cliente (canal externo) contém? → A: Aviso genérico de transação suspeita com tipo, valor e data, e orientação para confirmar ou contestar; sem regras, pontuação ou severidade.
- Q: Como consolidar severidade e pontuação das regras acionadas? → A: Severidade = a maior entre as regras acionadas; pontuação = soma dos pesos das regras acionadas, limitada a 100.
- Q: O que fazer com regras inválidas ou configuração de regras ausente/malformada na inicialização? → A: O serviço não inicia, com erro claro nos logs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Transação suspeita gera alerta (Priority: P1)

Um serviço de origem publica um evento de transação na fila de entrada. O motor lê o evento, confirma que ele é válido, avalia as regras de fraude usando somente os dados do próprio evento e, se alguma regra indicar suspeita, gera um único alerta para a transação. Transações sem suspeita são processadas e concluídas sem gerar alerta.

**Why this priority**: É o valor central do produto: identificar transações suspeitas em tempo real. Sem este fluxo não há detecção.

**Independent Test**: Publicar na fila um evento válido que viole uma regra e outro que não viole nenhuma; verificar que o primeiro produz exatamente um alerta com as regras acionadas e o segundo não produz nenhum, e que ambos saem da fila.

**Acceptance Scenarios**:

1. **Given** um evento válido que satisfaz ao menos uma regra de fraude, **When** o motor o processa, **Then** é gerado um alerta que identifica a transação, a severidade e as regras acionadas, e o evento é removido da fila.
2. **Given** um evento válido que não satisfaz nenhuma regra, **When** o motor o processa, **Then** nenhum alerta é gerado e o evento é removido da fila.
3. **Given** um evento que satisfaz várias regras, **When** o motor o processa, **Then** é gerado um único alerta que lista todas as regras acionadas.
4. **Given** o mesmo evento entregue mais de uma vez (reentrega ou concorrência), **When** o motor o processa novamente, **Then** não é criado um segundo alerta para a mesma transação, e as entregas pendentes aos canais são completadas.
5. **Given** dois eventos idênticos em conteúdo mas enviados em momentos diferentes, **When** ambos são avaliados, **Then** a decisão é a mesma, pois não depende de histórico de outras transações.

---

### User Story 2 - Evento inválido é rejeitado sem perda (Priority: P1)

Quando o evento lido da fila não é válido (JSON ilegível, campo obrigatório ausente, valor fora do permitido, campo desconhecido ou versão de contrato não suportada), o motor não o avalia. Ele o rejeita, registra o motivo e o encaminha para a fila de mensagens mortas (DLQ) preservando o conteúdo original para diagnóstico e reprocessamento.

**Why this priority**: Eventos malformados não podem gerar decisões erradas nem travar a fila. Rejeitar com rastreabilidade é parte do núcleo do fluxo e tem a mesma criticidade do caminho feliz.

**Independent Test**: Publicar eventos com defeitos distintos (campo obrigatório ausente, tipo errado, valor negativo, campo extra com dado pessoal, JSON truncado, versão major desconhecida) e verificar que nenhum gera alerta e que cada um aparece na DLQ com código de motivo e conteúdo original.

**Acceptance Scenarios**:

1. **Given** um evento que viola o contrato de entrada, **When** o motor o valida, **Then** ele é rejeitado, nenhuma regra é avaliada, nenhum alerta é gerado e uma mensagem com o motivo da rejeição é enviada à DLQ.
2. **Given** uma mensagem que não é JSON válido, **When** o motor tenta lê-la, **Then** ela é rejeitada com motivo de erro de leitura e o conteúdo original é preservado.
3. **Given** um evento com versão principal de contrato não suportada, **When** o motor o valida, **Then** ele é rejeitado com motivo de versão não suportada.
4. **Given** um evento rejeitado, **When** o motivo é registrado, **Then** o registro não contém dados pessoais nem o conteúdo da mensagem (apenas o caminho do campo inválido e o código do motivo).
5. **Given** uma mensagem rejeitada, **When** ela é enviada à DLQ, **Then** a mensagem original é removida da fila de entrada e não é reentregue indefinidamente.

---

### User Story 3 - Alerta chega aos canais interno e externo (Priority: P2)

Quando um alerta é gerado, ele é entregue ao canal interno (equipe antifraude) e ao canal externo (cliente afetado). Cada canal é independente: a falha de um não impede nem atrasa o outro, e entregas que falham são retentadas e, ao esgotar as tentativas, registradas na DLQ.

**Why this priority**: Um alerta que ninguém recebe não tem valor, mas a geração e a persistência do alerta (Story 1) já entregam a decisão. A entrega multicanal amplia o valor e depende de um alerta existente.

**Independent Test**: Gerar um alerta e verificar que há uma entrega para o canal interno e outra para o externo; simular indisponibilidade de um canal e verificar que o outro é entregue e que a entrega falha vai para retentativa e, depois, para a DLQ.

**Acceptance Scenarios**:

1. **Given** um alerta recém-gerado, **When** ele é roteado, **Then** é criada uma entrega para o canal interno e uma para o canal externo.
2. **Given** o canal externo indisponível, **When** o alerta é entregue, **Then** o canal interno recebe o alerta normalmente e a entrega externa é retentada.
3. **Given** uma entrega que esgotou as tentativas, **When** a última tentativa falha, **Then** a entrega é encaminhada à DLQ com o motivo, sem perda silenciosa.
4. **Given** a mesma entrega repetida por reprocessamento, **When** ela é reenviada ao mesmo canal, **Then** o receptor consegue reconhecê-la como duplicada.
5. **Given** um alerta com destino ao cliente, **When** a mensagem é montada, **Then** ela traz o aviso genérico com tipo, valor e data da transação e não expõe dados de uso exclusivo da equipe interna (como regras acionadas, pontuação e severidade).

---

### Edge Cases

- Evento de estorno (`TRANSACTION_REVERSED`): é validado normalmente, mas não é avaliado por regras e não gera alerta; é concluído e removido da fila.
- Evento de recusa (`TRANSACTION_DECLINED`): exige o motivo da recusa na validação e é avaliado pelas regras como uma transação autorizada.
- Evento válido cuja avaliação de uma regra falha por erro inesperado: não é descartado; é tratado como falha de processamento, retentado até 3 vezes e, ao esgotar as tentativas, enviado à DLQ (FR-003a).
- Falha ao gravar ou publicar o alerta após a decisão: o evento não pode ser confirmado como processado; ao ser reentregue não deve duplicar o alerta.
- Reentrega do mesmo evento com `eventId` diferente mas mesma transação: não gera alerta duplicado.
- Valor da transação zero ou muito alto: tratado pelas regras, sem erro de validação (zero é válido; negativo é inválido).
- Pico de volume acima da capacidade nominal: os eventos permanecem na fila e são consumidos conforme a capacidade, sem perda.
- Evento com data de ocorrência no futuro ou muito antiga: é validado como qualquer outro; a decisão stateless não depende de ordem temporal.
- Fila de entrada com mensagens fora de ordem: a decisão não depende da ordem entre transações.

## Requirements *(mandatory)*

### Functional Requirements

**Recebimento**

- **FR-001**: O sistema MUST consumir eventos de transação da fila de entrada de forma contínua e automática.
- **FR-002**: O sistema MUST confirmar (remover da fila) um evento somente após o resultado do seu processamento ser durável: alerta registrado, ausência de suspeita concluída, ou rejeição encaminhada à DLQ.
- **FR-003**: O sistema MUST tolerar entrega repetida da mesma mensagem sem produzir efeitos duplicados.
- **FR-003a**: Diante de falha transitória no processamento de um evento válido (erro inesperado na avaliação, falha ao gravar ou publicar o alerta), o sistema MUST retentar até 3 vezes com espera crescente e, ao esgotar as tentativas, MUST enviar o evento à DLQ com o motivo de tentativas esgotadas, sem bloquear o consumo dos demais eventos.

**Validação e rejeição**

- **FR-004**: O sistema MUST validar cada evento contra o contrato de entrada versionado (`TransactionEvent v1`) antes de qualquer avaliação de regra.
- **FR-005**: O sistema MUST rejeitar eventos que violem o contrato, incluindo campos obrigatórios ausentes, tipos ou valores inválidos, campos desconhecidos, formato de mensagem ilegível e versão principal de contrato não suportada.
- **FR-006**: O sistema MUST aceitar qualquer versão secundária compatível `1.x` do contrato.
- **FR-007**: O sistema MUST enviar toda mensagem rejeitada para a DLQ no formato do contrato `DlqMessage v1`, com etapa, código de motivo, detalhe técnico sem dados pessoais e conteúdo original preservado.
- **FR-008**: O sistema MUST NOT avaliar regras nem gerar alerta para eventos rejeitados.
- **FR-009**: O sistema MUST registrar a rejeição em log estruturado e em métrica, sem dados pessoais nem o conteúdo da mensagem.

**Decisão de fraude (stateless)**

- **FR-010**: O sistema MUST decidir se uma transação é suspeita usando exclusivamente os dados do próprio evento e a configuração das regras.
- **FR-011**: O sistema MUST NOT consultar nem manter histórico de outras transações, contadores, janelas de tempo ou qualquer estado entre eventos para decidir.
- **FR-012**: O sistema MUST produzir o mesmo resultado para o mesmo evento e o mesmo conjunto de regras, independentemente da ordem, do momento ou do número de vezes que for processado.
- **FR-013**: O sistema MUST avaliar todas as regras aplicáveis ao evento e consolidar as acionadas em uma única decisão, em que a severidade é a maior entre as regras acionadas e a pontuação é a soma dos pesos das regras acionadas, limitada a 100.
- **FR-014**: O sistema MUST reconhecer como inválida, na carga da configuração, qualquer regra que dependa de estado ou janela temporal, e MUST NOT aplicá-la.
- **FR-014b**: O sistema MUST NOT iniciar o consumo da fila se a configuração de regras estiver ausente, vazia ou malformada, ou se contiver qualquer regra inválida (incluindo as que dependam de estado ou janela), e MUST registrar em log o motivo de forma clara e sem dados pessoais.
- **FR-010a**: O sistema MUST avaliar as regras para eventos de transação autorizada e recusada, e MUST NOT avaliá-las para eventos de estorno, que, depois de válidos, são concluídos sem alerta.
- **FR-014a**: O sistema MUST ser entregue com um conjunto inicial de 2 a 4 regras stateless de exemplo, definidas na configuração e alteráveis sem mudar o código do motor: valor alto, valor alto para contraparte nova, país do comerciante de risco, e combinação incomum de canal e tipo de transação. Os limiares e listas são parâmetros da configuração.
- **FR-015**: Cada regra acionada MUST registrar identificador, versão, severidade, explicação legível sem dados pessoais e as evidências que a dispararam.

**Geração de alertas**

- **FR-016**: O sistema MUST gerar um alerta quando ao menos uma regra for acionada, no formato do contrato `FraudAlert v1`.
- **FR-017**: O sistema MUST gerar no máximo um alerta por transação, com chave determinística de deduplicação garantida pelo armazenamento (não apenas em memória), mesmo sob reentrega ou consumidores concorrentes.
- **FR-017a**: Quando um evento for reentregue e o alerta da transação já existir, o sistema MUST NOT criar novo alerta, e MUST completar as entregas aos canais que ainda estiverem pendentes, sem repetir as já concluídas.
- **FR-018**: O sistema MUST registrar no alerta os marcos de tempo (ingestão, consumo, detecção, publicação) e a latência total.
- **FR-019**: O sistema MUST persistir o alerta antes de confirmar o evento de entrada.

**Entrega aos canais**

- **FR-020**: O sistema MUST entregar cada alerta ao canal interno (equipe antifraude) e ao canal externo (cliente).
- **FR-021**: O sistema MUST tratar cada canal de forma independente: a falha ou lentidão de um canal MUST NOT impedir a entrega ao outro nem a detecção de novas transações.
- **FR-022**: O sistema MUST aplicar limite de tempo, retentativa com espera crescente e estratégia de degradação em toda chamada a canal.
- **FR-023**: O sistema MUST encaminhar à DLQ, com motivo, toda entrega que esgotar as tentativas, sem perda silenciosa.
- **FR-024**: O sistema MUST identificar cada entrega de forma estável entre retentativas, para que o receptor detecte duplicidade.
- **FR-025**: A mensagem ao cliente MUST conter um aviso genérico de transação suspeita com o tipo, o valor e a data da transação e a orientação para confirmar ou contestar, e MUST NOT incluir dados de uso exclusivo da equipe interna (regras acionadas, pontuação, severidade, evidências).

**Segurança e operação**

- **FR-026**: O sistema MUST proteger os dados em trânsito e em repouso e autenticar a comunicação com os canais.
- **FR-027**: O sistema MUST NOT registrar em log dados pessoais (endereço IP, geolocalização, identificadores em claro) nem segredos.
- **FR-028**: O sistema MUST emitir logs estruturados, métricas (volume processado, alertas, rejeições, latência, entregas com falha) e verificações de saúde (liveness/readiness).
- **FR-029**: O sistema MUST propagar o identificador de rastreamento do evento até o alerta e as entregas.

### Key Entities

- **Evento de transação**: fato imutável de uma transação (identificador de negócio, tipo de evento, tipo de transação, canal, valor, cliente e conta como tokens opacos, contraparte, comerciante, origem). É a única fonte de dados da decisão.
- **Regra de fraude (stateless)**: condição sobre os campos de um único evento, com identificador, versão, severidade e explicação. Não usa histórico nem janela.
- **Decisão de fraude**: resultado da avaliação de um evento: regras acionadas, severidade consolidada e pontuação; vazia quando não há suspeita.
- **Alerta de fraude**: registro único por transação suspeita, com decisão, resumo mascarado da transação, marcos de tempo, latência e chave de deduplicação.
- **Entrega de alerta**: tentativa de notificação de um alerta a um canal (interno ou externo), com identificador estável e estado.
- **Mensagem de DLQ**: envelope de uma mensagem que não pôde ser processada ou entregue, com etapa, motivo, tentativas e conteúdo original preservado.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% dos eventos que violam o contrato de entrada são rejeitados e encaminhados à DLQ com motivo e conteúdo original, e 0% deles geram alerta.
- **SC-002**: Para qualquer transação, o número de alertas gerados é no máximo 1, inclusive em testes de reentrega e processamento concorrente do mesmo evento.
- **SC-003**: Em 100% dos casos de teste, o mesmo evento produz a mesma decisão independentemente da ordem de chegada, do número de repetições e da presença de outros eventos.
- **SC-004**: O alerta é publicado em até 500 ms após o evento ser aceito na fila (percentil 99), sustentando 8.000 transações por segundo, com picos de até 25 mil.
- **SC-005**: Com um dos canais indisponível, 100% dos alertas continuam sendo gerados e entregues ao outro canal, sem aumento da latência de detecção.
- **SC-006**: Nenhuma mensagem é perdida silenciosamente: todo evento de entrada termina em exatamente um destes estados: sem suspeita, alerta gerado ou rejeitado na DLQ; toda entrega termina entregue ou na DLQ.
- **SC-007**: Nenhum dado pessoal ou segredo aparece nos logs e métricas em uma revisão com eventos de teste que contêm endereço IP e geolocalização.
- **SC-008**: Um operador identifica, apenas pelas métricas e logs, o volume processado, o número de alertas, de rejeições e de entregas com falha em qualquer janela de tempo.

## Assumptions

- A fila de entrada é a SQS (emulada com LocalStack no ambiente local), com semântica de entrega ao menos uma vez; a DLQ é uma fila separada.
- O contrato `TransactionEvent v1` e os demais contratos em `docs/contratos/` são a fonte da verdade para formatos de evento, alerta, entrega e DLQ.
- O conjunto de regras stateless é fornecido por configuração versionada, carregada na inicialização, e a primeira entrega traz apenas as regras de exemplo de FR-014a (as regras de negócio definitivas ficam para depois); a administração de regras em tempo de execução via API, e regras com janela ou estado (como velocidade de transações), estão fora do escopo desta feature.
- Os serviços de origem já publicam eventos no formato do contrato; a produção de eventos e a ingestão via HTTP estão fora do escopo.
- O canal interno é a fila/webhook da equipe antifraude, e o canal externo é a notificação ao cliente (push, SMS ou e-mail) por provedor de terceiros; a política de canais é fixa (um alerta vai aos dois canais) nesta feature.
- O estado de ciclo de vida do alerta (reconhecer, confirmar fraude, falso positivo) e a consulta de alertas por analistas estão fora do escopo.
- A latência é medida desde o aceite do evento pela fila até a publicação do alerta, incluindo o tempo de espera na fila.
