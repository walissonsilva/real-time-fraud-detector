# 05 — Histórias de usuário e plano de entrega incremental

> Status: **v0.1** · Base: [premissas](01-premissas.md), [RF](02-requisitos-funcionais.md), [RNF](03-requisitos-nao-funcionais.md), [ADRs](adr/README.md), [contratos](contratos/README.md).
> Este documento **reorganiza** o [plano por dia](04-plano-implementacao.md) em histórias entregáveis em fatias verticais. Cada release termina com `main` verde e uma demo curta. Os requisitos não são reescritos aqui; cada história aponta para os IDs de origem.

## Como a priorização foi pensada

O desafio avalia, antes de volume de código, **decisões de arquitetura, tratamento de falhas, consistência, testes e equilíbrio entre simplicidade e robustez**. Por isso a ordem não é "camada por camada", e sim "o que prova mais senioridade primeiro, sempre sobre um fluxo que já funciona":

1. **Fluxo mínimo ponta a ponta** (R1): sem ele, nada mais é demonstrável.
2. **Invariantes de correção** (R2): unicidade durável, outbox e *ack* só após persistir. É onde a maioria dos candidatos erra e onde o avaliador mais pressiona.
3. **Falha como funcionalidade** (R3, R4): canais, retry, circuit breaker, DLQ, recuperação.
4. **Evolução sem redeploy com governança** (R5): regras em runtime, aprovação, auditoria.
5. **Operar o que foi construído** (R6, R7): SRE, segurança, LGPD.
6. **Evidência** (R8, R9): carga, caos, relatório honesto e documentação coerente com o código.
7. **Opcionais** (R10): só depois de tudo acima estar verde.

Legenda: **Prio** M/S/C como nos RF · **Tam** P (≤ 2 h), M (2–4 h), G (4–8 h) · **Sinal** = o que a história demonstra ao avaliador.

## Mapa de releases

| Release | Tema | Pergunta que responde | Corte |
|---------|------|-----------------------|-------|
| **R0** | Base executável | O ambiente sobe do zero? | ✅ concluído |
| **R1** | Walking skeleton | Existe um fluxo evento → alerta funcionando? | Não cortar |
| **R2** | Consistência e durabilidade | O alerta é único e nunca se perde? | Não cortar |
| **R3** | Entrega por canais | O alerta chega à equipe e ao cliente? | Não cortar |
| **R4** | Resiliência e recuperação | O que acontece quando algo cai? | Não cortar |
| **R5** | Regras em runtime e governança | Dá para mudar a detecção sem redeploy, com controle? | Não cortar |
| **R6** | Observabilidade e SRE | Dá para operar e diagnosticar? | Cortar dashboards/burn-rate por último |
| **R7** | Segurança e LGPD | Está protegido de ponta a ponta? | Reduzir a "demonstrado local + documentado" |
| **R8** | Carga, caos e evidências | Aguenta? Prove. | Reduzir duração; nunca extrapolar |
| **R9** | Arquitetura, documentação e fechamento | Está defensável? | Sem features novas |
| **R10** | Opcionais (S/C) | O que sobra de valor? | Só se R1–R8 verdes |

### Cronograma-alvo (08–12/10, fim do dia 12)

| Dia | Entrega |
|-----|---------|
| Qui 08/10 | R1 completo; início de R2 |
| Sex 09/10 | R2 completo; R3 completo |
| Sáb 10/10 | R4 completo; R5 (US-19 a US-22) |
| Dom 11/10 | R5 (US-23, US-24); R6; R7 mínimo; R8 (carga curta + caos) |
| Seg 12/10 | R9: ensaio, instalação do zero, matriz, demo. Nenhuma feature nova |

Isso é apertado. Pontos de decisão: se R2 não estiver verde ao fim de sex 09, R3 reduz-se ao canal interno; se R5 não estiver estável ao fim de dom 11, adiar US-24 (auditoria completa). Todo desvio vai para a matriz de US-42.

---

## R0 — Base executável (concluído)

### US-01 · Ambiente reproduzível e contratos validados ✅
**Como** desenvolvedor, **quero** subir Postgres, Redis, SQS e SNS com um comando e ter CI e contratos validados, **para** trabalhar com feedback rápido.
- Compose com LocalStack (filas, DLQs, SNS FIFO), migração `001_init.sql`, health, CI (lint, build, unit, integração, e2e), validação de schemas e OpenAPI.
- **Origem:** RNF-54, RNF-51, RNF-29 (imagem não-root) · **Estado:** concluído nos commits `fac96bd`–`310dcec`.

---

## R1 — Walking skeleton

**Demo:** enviar um evento normal (sem alerta) e um suspeito (1 alerta) e ver o resultado na fila do canal antifraude.

### US-02 · Consumir e validar eventos de transação
**Como** motor de detecção, **quero** consumir `TransactionEvent v1` da fila e validar contra o schema, **para** só processar entrada confiável.
- Dado um evento válido, quando consumido, então `ingestedAt` vem do `SentTimestamp` do broker e `consumedAt` é o início do processamento.
- Dado um evento inválido, então é rejeitado sem derrubar o consumidor (DLQ formal chega em US-14).
- Config AWS/SQS lida de variáveis de ambiente (hoje só `DATABASE_URL`/`REDIS_URL`).
- **Origem:** RF-01, RF-02 (parcial), RF-05, RNF-55 · **Prio:** M · **Tam:** M · **Sinal:** ports/adapters reais; semântica de tempo correta desde o início.

### US-03 · Avaliar regras stateless
**Como** analista antifraude, **quero** que cada evento seja avaliado contra regras de valor, país, MCC e horário, **para** identificar transações suspeitas.
- Motor atrás da porta `RuleEngine`, regras vindas de config tipada (sem `eval`); a troca por CEL/JSON Logic (US-21) não altera o use case.
- Agregação: `severity` = maior severidade; `score` por função configurável; fuso da regra de horário e campo ausente definidos e testados.
- Evento sem regra disparada não gera alerta (só métrica e log amostrado).
- **Origem:** RF-10, RF-11, RF-16, RF-17, RF-18 (porta), RNF-07, RNF-50 · **Prio:** M · **Tam:** G · **Sinal:** domínio puro, testado (meta ≥ 80% de cobertura).

### US-04 · Gerar e publicar o alerta (caminho feliz)
**Como** equipe antifraude, **quero** receber um `FraudAlert v1` quando uma transação for suspeita, **para** investigar.
- Caso de uso: avaliar → `saveWithOutbox` → publicar no SNS → `markPublished` → *ack*. Reusa `PostgresAlertRepository`.
- Alerta com resumo mascarado, regras disparadas e *timestamps*, validado contra o schema.
- Teste e2e: evento normal sem alerta; suspeito com 1 alerta e 1 mensagem na fila antifraude. Script produtor de eventos incluído.
- **Origem:** RF-30, RNF-24 · **Prio:** M · **Tam:** G · **Sinal:** fluxo demonstrável desde o dia 1.

---

## R2 — Consistência e durabilidade

**Demo:** reenviar o mesmo evento e processá-lo em dois workers; matar o processo entre commit e publicação; derrubar o Postgres. Resultado: 1 alerta, nenhuma perda.

### US-05 · Alerta único por transação
**Como** equipe antifraude, **quero** no máximo um alerta por `transactionId`, **para** não ser inundada por duplicatas.
- Unicidade por `UNIQUE (dedupe_key)` com `ON CONFLICT DO NOTHING`; cache nunca substitui a restrição.
- Cenários 1 (duplicado) e 2 (*race* entre consumidores) automatizados contra Postgres real.
- Evento de outro tipo na mesma transação é avaliado, mas não cria segundo alerta (P-07). Resolver a divergência RF-04 × RNF-15 em ADR-02.
- **Origem:** RF-04, RF-31, RNF-14, RNF-15 · **Prio:** M · **Tam:** M · **Sinal:** idempotência garantida no armazenamento, não "por esperança".

### US-06 · Outbox transacional com relay
**Como** operador, **quero** que alerta e intenção de publicação sejam gravados atomicamente, **para** nunca ter alerta sem publicação.
- Relay periódico (≈ 5 s) republica entradas pendentes antigas. Corrigir `claimPendingOutbox`, que hoje roda fora de transação e solta o `FOR UPDATE SKIP LOCKED` imediatamente.
- Cenário 3: falha após persistir e antes de publicar → o relay publica depois, sem duplicidade para o consumidor (`alertId`).
- Semântica de `publishedAt` documentada: SLO medido no aceite confirmado pelo broker.
- **Origem:** RF-32, RNF-14, ADR-04 · **Prio:** M · **Tam:** G · **Sinal:** *transactional outbox* correto, incluindo o defeito de lock.

### US-07 · *Ack* somente após persistir (RPO = 0)
**Como** operador, **quero** que o evento só seja confirmado após o resultado estar durável, **para** não perder eventos aceitos.
- Banco indisponível: evento com alerta não é confirmado, volta à fila com recuo (`ChangeMessageVisibility`); evento sem alerta é confirmado.
- Morte do processo durante o processamento: a mensagem reaparece e é reprocessada sem duplicar.
- *Visibility timeout* definido a partir do p99 medido (ADR-01).
- **Origem:** RF-43, RNF-12, RNF-08 · **Prio:** M · **Tam:** M · **Sinal:** raciocínio explícito sobre ordem commit → publish → ack.

---

## R3 — Entrega por canais

**Demo:** um alerta chega ao canal antifraude e ao provedor externo simulado; reentrega não duplica efeito.

### US-08 · Canal interno antifraude
**Como** analista, **quero** receber o alerta na fila/webhook da equipe, **para** agir rapidamente.
- Consumidor da fila `alert-deliveries-antifraud-queue.fifo`; `deliveryId` estável por alerta/canal; `alertId` como chave de idempotência (`Idempotency-Key`).
- Tentativas e resultados persistidos na tabela `deliveries`; reentrega do mesmo `deliveryId` não gera segundo efeito.
- **Origem:** RF-34, RF-39, RNF-14 · **Prio:** M · **Tam:** M · **Sinal:** idempotência também na saída.

### US-09 · Canal externo (cliente) com provedor simulado
**Como** cliente, **quero** ser avisado de uma transação suspeita, **para** confirmar ou bloquear.
- Porta `NotificationProvider` com adaptador simulado e falhas controláveis (latência, erro, indisponibilidade) via configuração.
- Canal de fallback também simulado (ex.: push → SMS).
- **Origem:** RF-35, RF-36 (base) · **Prio:** M · **Tam:** M · **Sinal:** simulador controlável é o que torna R4 testável.

---

## R4 — Resiliência e recuperação

**Demo:** derrubar o provedor externo e mostrar detecção contínua, retry, circuit breaker, fallback e DLQ; enviar evento malformado e ver o fluxo seguir; recuperar e drenar.

### US-10 · Timeouts, retry com jitter
**Como** operador, **quero** que toda chamada externa tenha timeout e retry limitado com jitter, **para** não amplificar falhas.
- Retry só em operações idempotentes; teto de tentativas; backoff exponencial com jitter.
- **Origem:** RF-36, RNF-18 · **Prio:** M · **Tam:** M · **Sinal:** disciplina de I/O.

### US-11 · Circuit breaker e fallback de canal
**Como** operador, **quero** isolar um provedor lento ou fora do ar e usar um canal alternativo, **para** manter a entrega e a detecção.
- Breaker por provedor (aberto, meio-aberto, fechado) com estado observável.
- Cenário 8: provedor fora → retry, breaker, fallback e DLQ; **a detecção não é afetada**.
- **Origem:** RF-36, RF-42, RNF-11 · **Prio:** M · **Tam:** G · **Sinal:** degradação planejada (ADR-05).

### US-12 · Bulkhead por canal
**Como** operador, **quero** filas e concorrência separadas por canal, **para** que um canal lento não afete os demais.
- Latência injetada em um canal não aumenta a latência dos outros.
- **Origem:** RNF-17 · **Prio:** M · **Tam:** P

### US-13 · Evento inválido vai para a DLQ com motivo
**Como** operador, **quero** que eventos malformados vão à DLQ com o motivo, **para** diagnosticar sem parar o fluxo.
- Mensagem `DlqMessage v1` com motivo e origem; cenário 10 automatizado.
- **Origem:** RF-02, cenário 10 · **Prio:** M · **Tam:** M

### US-14 · DLQ de entrega e redrive idempotente
**Como** operador, **quero** reprocessar a DLQ sob demanda sem duplicar alertas, **para** recuperar de falhas terminais.
- Comando operacional com limite de ciclos (`redriveCount`); redrive não cria novo alerta. Replay histórico fica fora do escopo.
- **Origem:** RF-44 (parte DLQ), RNF-13 · **Prio:** M (DLQ) / S (intervalo de tempo) · **Tam:** M

### US-15 · *Graceful shutdown* e *backpressure*
**Como** operador, **quero** que um deploy ou sobrecarga não perca mensagens em voo, **para** manter RPO = 0.
- SIGTERM: para de consumir, termina as mensagens em voo e encerra. Sob sobrecarga, o consumo desacelera (concorrência limitada) em vez de estourar memória.
- **Origem:** RF-45, RNF-08 · **Prio:** M · **Tam:** M

### US-16 · *Kill switch* de canal
**Como** operador, **quero** desligar um canal imediatamente sem deploy, **para** conter um incidente.
- **Origem:** RF-53, RNF-46 · **Prio:** M · **Tam:** P

---

## R5 — Regras em runtime e governança

**Demo:** uma pessoa cria uma regra e outra aprova; o comportamento muda em até 30 s sem reinício; rollback restaura; autoaprovação é rejeitada; com o repositório de regras fora, o snapshot é mantido.

### US-17 · Regras como dados versionados (CRUD)
**Como** administrador de regras, **quero** criar, listar, consultar, editar e arquivar regras, **para** evoluir a detecção sem código.
- Toda alteração gera nova versão imutável (`rule_versions`); só a versão publicada é avaliada. Reusa o schema e a migração existentes.
- **Origem:** RF-20, RF-21 · **Prio:** M · **Tam:** G

### US-18 · Atualização em runtime com snapshot atômico
**Como** operador, **quero** que as instâncias recarreguem regras em até 30 s e mantenham o último snapshot válido, **para** operar mesmo com o repositório de regras fora.
- Contador `rules_revision`; troca atômica do conjunto compilado; cada decisão registra a versão usada.
- Bootstrap sem snapshot não processa silenciosamente com conjunto vazio.
- Cenários 5 e 6 automatizados.
- **Origem:** RF-23, RF-40, RNF-06 · **Prio:** M · **Tam:** G · **Sinal:** consistência de configuração em sistema distribuído.

### US-19 · Validar regra antes de aceitar
**Como** equipe de segurança, **quero** rejeitar regra perigosa, lenta ou não suportada, **para** que ela não degrade a detecção.
- Sem `eval`; limites de tamanho, profundidade, operadores e custo. Regra `WINDOWED` na fase 1 → erro claro (cenário 12). Regra maliciosa/lenta → rejeitada (cenário 11).
- **Spike do ADR-03** (CEL × JSON Logic, ≈ 30 min) decide a linguagem; vira novo adaptador de `RuleEngine`.
- **Origem:** RF-26, RF-18, RNF-30 · **Prio:** M · **Tam:** G · **Sinal:** segurança do motor de expressões.

### US-20 · Aprovação separada e rollback
**Como** gestor de risco, **quero** que quem cria uma regra não possa aprová-la, **para** garantir revisão por outra pessoa.
- `DRAFT → ACTIVE → ARCHIVED`; `approve` exige aprovador ≠ autor (também garantido por `CHECK` no banco); rollback para versão anterior em um comando.
- **Origem:** RF-22, P-34 · **Prio:** M · **Tam:** M

### US-21 · Autenticação e autorização na API
**Como** responsável de segurança, **quero** JWT (assinatura, expiração, issuer/audience, escopos) e papéis, **para** que só pessoas autorizadas alterem regras.
- Papéis `fraud-rules-admin`, `fraud-rules-approver`, `fraud-analyst`, `producer`; 401/403 testados.
- **Origem:** RNF-22, RNF-23 · **Prio:** M · **Tam:** G

### US-22 · *Kill switch* de regra e trilha de auditoria imutável
**Como** auditor, **quero** registro imutável de toda mudança de regra e acesso administrativo, **para** rastrear quem fez o quê.
- `audit_log` somente de inserção, gravado na mesma transação da mudança, sem endpoint de alteração. Kill switch de regra efetivo sem deploy.
- **Origem:** RF-53, RNF-28, RNF-46 · **Prio:** M · **Tam:** M

---

## R6 — Observabilidade e SRE

**Demo:** painel com p99 de ponta a ponta, lag, backlog do outbox, DLQ e estado dos breakers; um alerta de burn-rate com link para o runbook.

### US-23 · Métricas dos SLIs
**Como** SRE, **quero** medir latência por etapa e saúde do pipeline, **para** saber se o SLO está sendo cumprido.
- `alert_e2e_latency_seconds`, `decision_latency_seconds` (todos os eventos), `queue_wait_seconds`, lag, idade da mensagem mais antiga, backlog do outbox, tamanho da DLQ, estado dos breakers, event loop lag. Sem identificadores de cliente em labels.
- **Origem:** RNF-03, RNF-04, RNF-41, RF-51 · **Prio:** M · **Tam:** G

### US-24 · Logs estruturados sem PII e *tracing* ponta a ponta
**Como** engenheiro de plantão, **quero** logs JSON correlacionados por `traceId`, **para** seguir uma transação da entrada à entrega.
- `traceparent` W3C propagado do evento ao canal; amostragem das decisões "sem alerta"; teste automatizado de *log scrubbing* (zero PII).
- **Origem:** RNF-25, RNF-42, RNF-43, RF-51 · **Prio:** M · **Tam:** M

### US-25 · Health e *readiness* reais
**Como** orquestrador, **quero** que `/health/ready` falhe quando uma dependência crítica estiver fora, **para** tirar a instância do tráfego.
- Hoje a readiness só consulta Postgres e Redis; incluir fila/SNS e snapshot de regras válido.
- **Origem:** RF-50 · **Prio:** M · **Tam:** P

### US-26 · SLOs, alertas de burn-rate e dashboards
**Como** SRE, **quero** SLOs definidos e alertas por *burn rate* ligados a runbooks, **para** reagir ao que importa ao usuário.
- SLOs: p99, disponibilidade 99,95%, frescor das regras ≤ 30 s, entrega interna ≥ 99,9% em 1 min. Dashboards de pipeline, regras, canais e dependências.
- **Origem:** RNF-40, RNF-44, RNF-45, RNF-10 · **Prio:** M (SLOs) / S (dashboards) · **Tam:** M

### US-27 · Runbooks e resposta a incidentes
**Como** engenheiro de plantão, **quero** runbooks para lag crescente, DLQ crescendo, provedor fora e regra ruim, **para** resolver incidentes sem improviso.
- Severidades SEV1–SEV3, papéis e modelo de *postmortem* sem culpados.
- **Origem:** RF-52, RNF-47 · **Prio:** M · **Tam:** M

---

## R7 — Segurança e LGPD

**Demo:** chamada sem credencial é negada; tráfego com TLS; busca de dados por `customerId`; varredura de dependências na CI.

### US-28 · Criptografia em trânsito e autenticação entre serviços
**Como** responsável de segurança, **quero** TLS 1.2+ e identidade de serviço, **para** que só serviços autorizados falem entre si.
- Demonstrar TLS/autenticação no ambiente de validação; mTLS ou OAuth2 *client credentials* para o canal interno (webhook com HMAC e `Idempotency-Key`). O alvo AWS é documentado como não implantado.
- **Origem:** RNF-20, RNF-22 · **Prio:** M · **Tam:** G

### US-29 · Criptografia em repouso, retenção e descarte
**Como** responsável de segurança, **quero** dados cifrados e com retenção definida, **para** cumprir a LGPD.
- KMS, rotação, backups e logs cifrados descritos na IaC/arquitetura alvo; TTL de expiração onde aplicável; arquitetura de retenção de 5 anos (partições mensais) **documentada, não implementada**.
- **Origem:** RNF-21, RNF-26 · **Prio:** M (documento) · **Tam:** M

### US-30 · Minimização de dados e direitos do titular
**Como** titular, **quero** que meus dados sejam minimizados e localizáveis, **para** exercer meus direitos.
- Contratos sem PAN/CPF/nome; consulta de alertas e eventos por `customerId` (token) com índice.
- **Origem:** RNF-24, RNF-27 · **Prio:** M · **Tam:** M

### US-31 · Resistência a abuso e cadeia de suprimentos
**Como** responsável de segurança, **quero** limites e varredura de dependências, **para** reduzir superfície de ataque.
- Limite de taxa e tamanho máximo (16 KiB) de payload; imagem mínima não-root; *secrets* fora do repositório; varredura de vulnerabilidades na CI.
- **Origem:** RNF-29, RNF-30, RNF-55 · **Prio:** M · **Tam:** M

---

## R8 — Carga, caos e evidências

**Demo:** relatório com p50/p95/p99, lag, drenagem, perdas e duplicidades; suíte de caos automatizada.

### US-32 · Gerador de eventos e baseline
**Como** engenheiro de desempenho, **quero** um gerador que publique no broker real, **para** medir de forma repetível.
- Produtor específico do broker; mistura de eventos normais e suspeitos com percentual de alertas configurável.
- **Origem:** RNF-01, RNF-53 · **Prio:** M · **Tam:** M

### US-33 · Carga sustentada, pico e drenagem
**Como** avaliador, **quero** ver latência e vazão medidas, **para** saber o que foi atingido.
- 8.000 TPS sustentados, pico de 25.000 TPS, drenagem em ≤ 5 min; medir entrada aceita, decisões e alertas publicados separadamente. Registrar hardware, versões, workers e parâmetros.
- Cada meta recebe **atingido / não atingido / não validado**; não extrapolar o que o ambiente local não sustenta. A carga atravessa broker e banco reais do Compose (cenário 9).
- **Origem:** RNF-01, RNF-02, RNF-03, RNF-04 · **Prio:** M · **Tam:** G

### US-34 · Escalabilidade e perfil de desempenho
**Como** arquiteto, **quero** comparar N e 2N workers e perfilar CPU, GC e event loop, **para** corrigir gargalos com evidência.
- Ajustes: batches, concorrência limitada, índices, menos I/O por evento; repetir só as medições afetadas.
- **Origem:** RNF-05, RNF-06, RNF-07 · **Prio:** M · **Tam:** G

### US-35 · Testes de caos por dependência
**Como** engenheiro, **quero** testes automatizados de falha de cada dependência, **para** provar o que o ADR-05 promete.
- Banco, broker, repositório de regras, provedor e morte de worker: contagem de eventos e unicidade verificadas após a recuperação (RTO ≤ 5 min).
- **Origem:** RNF-11, RNF-12, RNF-13, RNF-52 · **Prio:** M · **Tam:** G · **Sinal:** resiliência demonstrada, não alegada.

---

## R9 — Arquitetura, documentação e fechamento

**Sem features novas.** Corrige, mede de novo o que mudou e prepara a defesa.

### US-36 · Decisões e diagramas
**Como** avaliador, **quero** entender as decisões e os trade-offs, **para** julgar a qualidade da arquitetura.
- ADRs 01–05 revisados e marcados como aceitos (incluindo ADR-03); diagramas C4 (contexto, contêineres) e fluxo de falhas em `docs/arquitetura/`.
- **Origem:** RNF-56, RNF-50, RNF-51 · **Prio:** M · **Tam:** M

### US-37 · Arquitetura AWS alvo, dimensionamento e custo
**Como** avaliador, **quero** ver como isso roda em produção, **para** avaliar viabilidade e custo.
- Multi-AZ, IaC (esboço), dimensionamento por TPS, retenção e backup, estimativa de custo com hipóteses e fontes datadas. Declarar o que **não** foi implantado.
- **Origem:** RNF-19, RNF-54, RNF-60, RNF-61 · **Prio:** M · **Tam:** M

### US-38 · README de execução, matriz RF/RNF e demo
**Como** avaliador, **quero** reproduzir tudo do zero e ver a rastreabilidade, **para** confiar no que foi entregue.
- Instalação limpa em outra máquina; cobertura do domínio ≥ 80%; matriz RF/RNF com evidência e status (**implementado / simulado / documentado / não validado**); roteiro de demo e apresentação ensaiados.
- **Origem:** RNF-52, RNF-53, RNF-55 · **Prio:** M · **Tam:** G

---

## R10 — Opcionais (só com R1–R8 verdes)

| ID | História | Origem | Prio | Tam | Observação |
|----|----------|--------|------|-----|------------|
| US-39 | Velocidade `COUNT` por `accountId` com Redis `ZSET`, lateness de 5 min, modo `degraded` | RF-12, RF-41, RNF-16, cenários 4 e 7 | S (fase 2) | G | Maior ganho técnico entre os opcionais; implementa a porta `WindowStateStore` |
| US-40 | Modo *shadow* de regra | RF-24 | S | M | Calibrar antes de ativar |
| US-41 | Simulação (*dry-run*) de regra | RF-25 | S | M | Depende de US-19 |
| US-42 | API de consulta por id e status do alerta | RF-38 | S | M | Listagem com filtros só documentada |
| US-43 | Política de roteamento dinâmica | RF-33 | S | M | Hoje é configuração externa |
| US-44 | Controle de fadiga de notificação | RF-37 | S | M | Agregação por janela |
| US-45 | Ingestão HTTP `POST /v1/transactions` | RF-03 | S | M | Responde `202` |
| US-46 | Listas de apoio (deny/allow) | RF-13 | S | M | |
| — | Perfil comportamental, scorer externo, rollout gradual | RF-14, RF-15, RF-27 | C | — | Documentados, não implementados |

---

## Rastreabilidade (nenhum requisito sem destino)

| Requisito | História(s) | Requisito | História(s) |
|-----------|-------------|-----------|-------------|
| RF-01 | US-02 | RF-36 | US-09, US-10, US-11 |
| RF-02 | US-02, US-13 | RF-37 | US-44 |
| RF-03 | US-45 | RF-38 | US-42 |
| RF-04 | US-05 | RF-39 | US-08 |
| RF-05 | US-02 | RF-40 | US-18 |
| RF-10, RF-11, RF-16, RF-17 | US-03 | RF-41 | US-39 |
| RF-12 | US-39 | RF-42 | US-11 |
| RF-13 | US-46 | RF-43 | US-07 |
| RF-14, RF-15, RF-27 | documentado (C) | RF-44 | US-14 |
| RF-18 | US-03, US-19 | RF-45 | US-15 |
| RF-20, RF-21 | US-17 | RF-50 | US-25 |
| RF-22 | US-20 | RF-51 | US-23, US-24 |
| RF-23 | US-18 | RF-52 | US-27 |
| RF-24 | US-40 | RF-53 | US-16, US-22 |
| RF-25 | US-41 | RNF-01 a RNF-04 | US-23, US-32, US-33 |
| RF-26 | US-19 | RNF-05 a RNF-07 | US-03, US-34 |
| RF-30 | US-04 | RNF-08 | US-07, US-15 |
| RF-31 | US-05 | RNF-10, RNF-40 | US-26 |
| RF-32 | US-06 | RNF-11 a RNF-13 | US-11, US-35 |
| RF-33 | US-43 | RNF-14, RNF-15 | US-05, US-06, US-08 |
| RF-34 | US-08 | RNF-16 | US-39 |
| RF-35 | US-09 | RNF-17, RNF-18 | US-10, US-12 |
| RNF-19 | US-37 | RNF-20 a RNF-22 | US-21, US-28 |
| RNF-21, RNF-26 | US-29 | RNF-23 | US-21 |
| RNF-24, RNF-27 | US-30 | RNF-25 | US-24 |
| RNF-28 | US-22 | RNF-29, RNF-30 | US-19, US-31 |
| RNF-41, RNF-42, RNF-43 | US-23, US-24 | RNF-44, RNF-45 | US-26 |
| RNF-46 | US-16, US-22 | RNF-47 | US-27 |
| RNF-50, RNF-51, RNF-56 | US-01, US-03, US-36 | RNF-52, RNF-53 | US-35, US-38 |
| RNF-54, RNF-55 | US-01, US-37, US-38 | RNF-60, RNF-61 | US-37 |

Cenários críticos: **1, 2** → US-05 · **3** → US-06 · **5, 6** → US-18, US-20 · **8** → US-11 · **9** → US-33 · **10** → US-13 · **11, 12** → US-19 · **4, 7** → US-39 (fase 2).

## Definição de pronto (vale para toda história)

- Critérios de aceite viram teste automatizado (unitário, integração ou e2e) e passam na CI (`lint`, `build`, `test`, `contracts:validate`, `test:int`, `test:e2e`).
- Contratos de `docs/contratos/` respeitados; nenhuma PII em logs, métricas ou traces.
- Decisão relevante registrada em ADR (alternativas e trade-offs).
- A história declara o que é **implementado**, **simulado**, **documentado** ou **não validado**.

## Uso com o Spec Kit

Cada release vira uma feature Spec Kit (`/speckit.specify` → `clarify` → `plan` → `tasks` → `analyze` → `implement`), e as histórias do release são os *user stories* da spec, com os IDs acima citados. R1, R2, R4 e R5 exigem `clarify`, pois envolvem decisões reais (semântica de tempo, ordem commit → publish → ack, retry e breaker, linguagem de regras). Limite de tempo por spec: ≈ 30–40 min, sem repetir o que já está em `docs/`.
