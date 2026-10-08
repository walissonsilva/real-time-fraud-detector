# 01 — Premissas e escopo

> Status: **rascunho v0.1** · Base: [desafio-tecnico.md](desafio-tecnico.md)
> Premissas são decisões assumidas para fechar lacunas do enunciado. Cada uma tem um ID (`P-xx`) para ser citada nos ADRs e defendida na apresentação. Se uma premissa mudar, o impacto está indicado.

## 1. Escopo

**Dentro do escopo**
- Ingestão de eventos de transação publicados por serviços internos.
- Avaliação de regras de detecção em tempo real, **em duas fases** (P-08): fase 1 com regras *stateless*; fase 2 (*stretch*) com uma regra de janela temporal (velocidade).
- Geração, persistência e entrega de alertas (equipe antifraude e cliente).
- Gestão de regras em runtime (criar, versionar, publicar, reverter, simular) sem redeploy.
- Segurança, observabilidade, resiliência e estratégia de recuperação.

**Fora do escopo**
- Bloquear/negar a transação (o motor **não** está no caminho síncrono de autorização).
- Modelos de ML treinados; o motor oferece o ponto de extensão, mas a entrega é baseada em regras.
- Gestão de casos pelo time antifraude (apenas o handoff do alerta e o status básico).
- UI de administração de regras (apenas API).
- Autenticação de clientes finais (o motor só confia em identidade de serviço).
- Regras com janela além da de velocidade (soma em período, *burst* de recusas, múltiplos dispositivos/países) e "viagem impossível": ficam **documentadas, não implementadas** (P-08).

## 2. Premissas de negócio

| ID | Premissa | Justificativa | Se mudar |
|----|----------|---------------|----------|
| P-01 | O motor é **assíncrono e não bloqueante**: detecta e alerta, não autoriza nem nega a transação. | O enunciado fala em "gerar alertas", não em decisão de autorização. Remove a exigência de latência síncrona no caminho do pagamento. | Se virar bloqueante, é preciso API síncrona, fail-closed/fail-open explícito e SLO de p99 bem mais baixo. |
| P-02 | Os serviços produtores já existem e publicam eventos de transação já **autorizados/finalizados** (e recusados) num barramento de eventos. | "Processando eventos de outros serviços internos". | Se produtores só falam HTTP, o adaptador HTTP de ingestão (contrato 4) vira caminho principal. |
| P-03 | Um evento de transação = um fato imutável. Identidade de negócio do evento = **`transactionId` + `eventType`**. Correções e estornos chegam como novo evento com `eventType` distinto e o mesmo `transactionId`, nunca como edição. | Facilita idempotência e reprocessamento. Deduplicar só por `transactionId` descartaria, por engano, o estorno de uma transação já vista. | Se o produtor reutilizar `transactionId` entre eventos sem `eventType` distinto, a chave passa a incluir `eventId`. |
| P-04 | Gera-se **no máximo um alerta por `transactionId`**, agregando todas as regras disparadas. | Reduz ruído para o analista e simplifica a chave de idempotência. | Alerta por regra exigiria `dedupeKey = transactionId + ruleId`. |
| P-05 | Alerta ao cliente é **notificação** (push/SMS/e-mail) por provedor externo; o motor entrega o pedido ao provedor, não garante leitura. | Entrega final depende de terceiros. | — |
| P-06 | Há um único tenant/instituição (Itaú). Sem multi-tenancy. | Simplicidade. | Adicionar `tenantId` aos contratos e às chaves de partição. |
| P-07 | A unicidade do alerta é por `transactionId` (P-04), mesmo com vários eventos da mesma transação. Eventos posteriores (ex.: `TRANSACTION_REVERSED`) atualizam o estado de janela e são avaliados, mas **não geram um segundo alerta**; o disparo adicional fica registrado na decisão e na trilha de auditoria. | Mantém a chave de idempotência simples e o analista com um único alerta por transação. | Anexar as regras novas ao alerta existente exigiria um `PATCH` do alerta e um evento `alert.updated`. |
| P-08 | **Entrega em duas fases.** **Fase 1 (obrigatória):** regras *stateless* (só o evento), com todo o pipeline: ingestão, idempotência, *outbox*, canais, resiliência, observabilidade e regras sem redeploy. **Fase 2 (se houver tempo):** uma única regra com janela, a de velocidade (`COUNT` por `accountId`), atrás da porta `WindowStateStore`. O restante das regras com janela é só desenho. | O enunciado não define o motor de decisão. Os critérios de avaliação (vazão, latência, idempotência, resiliência, segurança) são demonstráveis sem estado de janela, que concentra o custo de ADR-02, ordenação e eventos atrasados. | Se a fase 2 não couber, na defesa ela entra como evolução com a porta e os contratos prontos. |

## 3. Premissas de carga e dados

| ID | Premissa | Valor | Base |
|----|----------|-------|------|
| P-10 | Vazão sustentada | **8.000 TPS** | [Enunciado] |
| P-11 | Pico (rajadas) | **25.000 TPS**, duração de até 15 min, até ~4x/dia (Black Friday, folha de pagamento, Pix em horário de pico) | [Enunciado] 25k TPS; [Estimativa] duração e frequência |
| P-12 | Latência | **≤ 500 ms** medidos de `ingestedAt` até `alert.publishedAt` (alerta persistido e publicado no tópico/fila de alertas). `ingestedAt` é o instante em que o **barramento aceitou o evento** (timestamp do broker; no adaptador HTTP, o recebimento na API), então **o tempo de espera na fila entra na conta**. O trecho do produtor até o barramento fica fora, pois não é controlado pelo motor. O envio ao provedor externo é medido à parte (SLO próprio, P-13). Meta: **p99 ≤ 500 ms**, p50 ≤ 150 ms. | [Enunciado] 500 ms; [Estimativa] p50/p99 como metas |
| P-13 | Entrega ao canal | Canais internos: p99 ≤ 2 s após a publicação. Provedores externos: melhor esforço, p99 ≤ 10 s, com retry e DLQ. | [Estimativa] |
| P-14 | Tamanho médio do evento | ~1 KB (JSON) → ~8 MB/s sustentado, ~25 MB/s em pico. | [Estimativa] |
| P-15 | Volume diário | 8k TPS × 86.400 s ≈ **690 M eventos/dia** (limite superior; a média real tende a ser menor). | [Derivada] de P-10 |
| P-16 | Taxa de alerta | **Valor de projeto: 0,1%** dos eventos (8 alertas/s a 8k TPS; 25/s no pico de 25k). **Faixa plausível: 0,02% a 0,3%** (1,6 a 24 alertas/s sustentado; 5 a 75/s no pico), derivada de fraude confirmada de 4 a 30 por 100 mil transações e precisão de alerta de 10% a 20%. O teste de carga parametriza a taxa e cobre de 0,02% a 5% (400 alertas/s sustentado, 1.250/s no pico); 100% serve de pior caso isolado do caminho de alerta. O caminho de alerta é bem menos exigente que o de ingestão. | [Estimativa fundamentada] ver [pesquisa](pesquisa-taxa-de-alertas.md) |
| P-17 | Cardinalidade (fase 2) | ~50 M de clientes ativos. Estado de janela por cliente em memória/cache só para os ativos nos últimos N minutos. | [Estimativa] |
| P-18 | Ordenação (necessária às regras com janela, fase 2; a partição por `accountId` vale desde a fase 1) | Eventos de **um mesmo cliente/conta** não precisam de ordem estrita: a contagem da regra de velocidade é comutativa e idempotente (ver [ADR-02](adr/ADR-02-dedupe-e-estado-de-janela.md)), então ordem aproximada basta. Não há exigência de ordem global. Chave de particionamento: `accountId`. | [Decisão de projeto] |
| P-19 | Eventos atrasados (fase 2) | Toleramos até **5 min** de atraso/fora de ordem (usa-se `occurredAt` com *allowed lateness*). Acima disso, o evento é processado em modo "tardio": regras com janela são reavaliadas em melhor esforço e o alerta carrega `late=true`. | [Estimativa] |
| P-20 | Retenção | Eventos brutos: 90 dias em storage frio (**só desenhado, não implementado**). Alertas e trilha de auditoria: 5 anos. Estado de janela: horas (TTL por regra). | [Estimativa] a confirmar com jurídico/DPO |
| P-21 | Retenção da DLQ | **14 dias**, cifrada e com acesso restrito (a mensagem original pode conter dados pessoais indiretos). Após reprocessar ou descartar, o payload é apagado e só o registro de auditoria permanece. | [Decisão de projeto] |

> **Base** de cada número: `[Enunciado]` vem do case; `[Derivada]` é cálculo a partir de outra premissa; `[Estimativa]` é suposição do autor, sem fonte; `[Estimativa fundamentada]` tem fonte pública e limites declarados; `[Decisão de projeto]` é escolha, não medição.
> Só P-10, P-11 (25k) e P-12 (500 ms) vêm do enunciado. Os demais números são premissas de dimensionamento e serão validados com teste de carga (k6), com o resultado registrado no relatório de resultados.

## 4. Premissas de segurança e conformidade

| ID | Premissa |
|----|----------|
| P-30 | O barramento é interno à rede corporativa; mesmo assim a comunicação é cifrada (TLS 1.2+) e autenticada (mTLS entre serviços; OAuth2 client-credentials/JWT para APIs). |
| P-31 | Os eventos **não trazem PAN, CPF nem nome em claro**. Identificadores são tokens opacos (`customerId`, `accountId`, `instrumentToken`). A resolução para dados pessoais, quando necessária ao canal de notificação, ocorre no serviço de notificação via serviço de cadastro/token vault (fora do escopo). |
| P-32 | Base legal LGPD: **prevenção à fraude e segurança do titular** (art. 7º, IX e art. 11, II, "g"; confirmar com jurídico/DPO). Aplicam-se minimização, finalidade, retenção definida e trilha de auditoria. |
| P-33 | Criptografia em repouso com chaves gerenciadas (KMS) e rotação; segredos em secret manager, nunca em imagem ou repositório. |
| P-34 | Mudanças de regra exigem papel `fraud-rules-admin`; a ativação exige que o aprovador seja diferente do autor (checagem no `approve`, sem estado `IN_REVIEW` no desafio) e fica na trilha de auditoria. |

## 5. Premissas de plataforma e entrega

| ID | Premissa |
|----|----------|
| P-40 | Stack-alvo: **Node.js/TypeScript (NestJS)**. Escolha justificada por domínio do autor e velocidade de entrega no prazo de 7 dias; limites de CPU e GC serão mitigados com escala horizontal e processamento em lote. |
| P-41 | Cloud: **AWS**. O ambiente de validação de carga deve ser simples e de baixo custo. Orquestração em EKS fica como alvo de produção documentado; o desafio roda localmente via Docker Compose e, se houver tempo, valida throughput na AWS. |
| P-42 | Mensageria: ver [ADR-01](adr/ADR-01-mensageria.md) (SQS padrão na entrada, SNS FIFO na saída; alternativa Kafka/MSK). Os contratos aqui são **independentes de broker**. |
| P-43 | O desafio entrega código executável + documentação + ADRs + testes + apresentação. Nem todo componente de produção será implementado; o que for simulado será declarado. |
| P-44 | Enunciado: take-home de 7 dias, seguido de defesa ao vivo. Planejamento interno atualizado em 07/10/2026: **6 dias de implementação, de 07 a 12/10/2026**, conforme [plano](04-plano-implementacao.md). A data da defesa e o prazo acordado com o avaliador precisam ser confirmados separadamente. |

## 6. Decisões em aberto (viram ADRs)

| # | Decisão | Opções | Impacto nos contratos |
|---|---------|--------|-----------------------|
| [ADR-01](adr/ADR-01-mensageria.md) | Mensageria (proposto: SQS + SNS FIFO) | SQS (+SNS) · Kafka/MSK · Kinesis | Nenhum no payload; muda a chave de partição (`MessageGroupId`/partition key). |
| [ADR-02](adr/ADR-02-dedupe-e-estado-de-janela.md) | Estado de janelas (fase 2, proposto: Redis `ZSET`) e deduplicação (fase 1, proposto: `UNIQUE` no Postgres) | Redis/ElastiCache · DynamoDB · estado local + changelog | Nenhum nos contratos. **Deduplicação** é decidida na fase 1 (restrição de unicidade no armazenamento, cache opcional). **Estado de janelas** fica adiado atrás da porta `WindowStateStore`. |
| [ADR-03](adr/ADR-03-motor-de-regras.md) | Motor de regras (linguagem **em aberto**: CEL ou JSON Logic) | JSON Logic · CEL · DSL própria | Campo `expression` do contrato de regra. |
| [ADR-04](adr/ADR-04-armazenamento.md) | Armazenamento de alertas/regras/auditoria (proposto: PostgreSQL) | DynamoDB · PostgreSQL | Nenhum nos contratos. |
| [ADR-05](adr/ADR-05-estrategia-de-degradacao.md) | Estratégia de degradação (proposto) | fail-open vs fail-closed por dependência | Campo `degraded` no alerta. |
