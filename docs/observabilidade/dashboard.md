# Dashboard

`fraud-detector-operacao`, no CloudWatch. A URL sai no output `dashboard_url` do Terraform. O intervalo padrão é de **3 horas**, com período automático. Os painéis seguem uma ordem de investigação: primeiro "o sistema está bem?", depois "onde está o problema?".

```
┌ Linha 0 ─ Saúde: p99 · TPS · idade da fila · DLQs · tasks · alertas/min ┐
├ Alarmes ─ todos os alarmes, em uma faixa                                 ┤
├ Linha 1 ─ Vazão · Latência · Backlog                                     ┤
├ Linha 2 ─ Eventos por resultado · Alertas e faixa · Teste de carga       ┤
├ Linha 3 ─ Outbox · Entregas por canal · DLQs                             ┤
├ Linha 4 ─ ECS CPU/memória · Tasks · RDS CPU/conexões                     ┤
├ Linha 5 ─ RDS escrita · Redis · Regras dinâmicas                         ┤
└ Linha 6 ─ Circuit breakers · Fallback e adiadas                          ┘
```

## Linha 0: o sistema está bem?

Seis números grandes, para olhar de relance.

| Painel | O que mostra | Saudável |
|---|---|---|
| **Latência do alerta p99 (ms) · SLO 500** | p99 de `AlertLatencyMs` em 5 min | abaixo de 500 |
| **Entrada (TPS)** | `NumberOfMessagesSent` ÷ 60 | acompanha o tráfego esperado |
| **Idade da msg mais antiga em transactions (s)** | `ApproximateAgeOfOldestMessage` | perto de 0 |
| **Mensagens nas DLQs** | soma das três DLQs | 0 |
| **Tasks rodando** | `RunningTaskCount` mínimo (sem Container Insights, mostra a CPU) | igual ao desejado |
| **Alertas por minuto** | `AlertsCreated` | dentro da faixa habitual |

Logo abaixo, a faixa **Alarmes** lista o estado de todos os alarmes (verde, vermelho ou sem dados).

## Linha 1: vazão, latência e backlog

| Painel | O que mostra | Como ler |
|---|---|---|
| **Vazão: entrada × consumo (eventos/s)** | Mensagens enviadas e processadas por segundo | As duas linhas devem coincidir. Entrada acima do consumo por tempo prolongado = fila crescendo |
| **Latência do alerta (ms)** | p50, p95 e p99, com linha do SLO em 500 ms | O p99 deve ficar abaixo da linha vermelha e **não crescer** ao longo do tempo |
| **Backlog da fila transactions** | Visíveis, em voo e idade da mais antiga (eixo direito) | Visíveis em dezenas e idade em 0 s é saudável. Idade subindo = consumo atrasado |

## Linha 2: o que acontece com os eventos

| Painel | O que mostra | Como ler |
|---|---|---|
| **Eventos processados por resultado** | Barras empilhadas por minuto: sem alerta, alerta criado, duplicado, rejeitado, falha transitória | Quase tudo é "sem alerta". "Rejeitado" ou "falha transitória" crescendo merece investigação |
| **Alertas por minuto e faixa esperada** | `AlertsCreated` sobre a faixa de anomalia | Sair da faixa é o que dispara `rules-alert-rate-anomaly` |
| **Teste de carga: TPS planejado × entrada** | TPS planejado, entrada real e a fase (1 aquec., 2 steady, 3 drain) | Só tem dados durante testes. Entrada real abaixo do planejado = gerador saturado |

## Linha 3: entrega, outbox e DLQ

| Painel | O que mostra | Como ler |
|---|---|---|
| **Outbox** | Pendentes, idade do mais antigo (ms), falhas de publicação e republicados pelo relay | Pendentes e idade perto de 0. Republicados subindo = publicação inline falhando |
| **Entregas por canal e idade das filas de canal** | Entregues, esgotaram retries, falha de infraestrutura e idade das filas de canal (eixo direito) | "Entregues" acompanha os alertas; idade da fila de canal subindo = entrega mais lenta que a produção |
| **DLQs e mensagens enviadas a DLQ** | Estoque visível em cada DLQ e envios por minuto | Estoque diferente de zero é falha; "enviadas/min" mostra quando começou |

## Linha 4: capacidade

| Painel | O que mostra | Como ler |
|---|---|---|
| **ECS: CPU e memória do serviço (%)** | Média e máxima, com linha do alarme em 85% | Nos testes a CPU média foi de 22% (1.000 TPS) e 50% (4.000 TPS); a memória fica baixa |
| **ECS: tasks rodando × desejadas** | Tasks em execução contra as desejadas | Só aparece com Container Insights. Diferença prolongada = task parada ou capacidade indisponível |
| **RDS: CPU e conexões** | CPU (eixo esquerdo) e conexões (direito) | Cada task abre um pool de até 20 conexões: mais tasks, mais conexões |

## Linha 5: dados e regras

| Painel | O que mostra | Como ler |
|---|---|---|
| **RDS: escrita (IOPS e latência)** | `WriteIOPS` e latência de escrita (s); o espaço livre existe mas está oculto | Latência de escrita é o primeiro lugar para olhar quando a latência do alerta sobe com a fila vazia |
| **Redis: CPU e conexões** | CPU do engine e conexões | O Redis está provisionado, mas o código de negócio não o usa; o painel serve de verificação básica |
| **Regras dinâmicas: revisão ativa e saúde do refresh** | Revisão máx. e mín., idade do último refresh e falhas | As duas revisões devem ser iguais. Divergência prolongada = rollout travado |

## Linha 6: degradação de canais

| Painel | O que mostra | Como ler |
|---|---|---|
| **Circuit breaker por canal** | Estado de antifraude, push e SMS: 0 fechado, 1 meio-aberto, 2 aberto (máximo entre tasks) | Qualquer valor 2 significa canal isolado. Não há alarme: este painel é o único aviso |
| **Fallback e entregas adiadas** | Entregues pelo canal alternativo, adiadas e esgotadas | Fallback subindo = push com problema e SMS assumindo; adiadas = breaker aberto ou canal desligado |

## Roteiro de investigação

1. **Linha 0**: algum dos seis números fugiu do normal?
2. **Faixa de alarmes**: algum está vermelho?
3. **Fila crescendo** (linha 1)? Veja CPU do ECS e do RDS (linha 4).
4. **Fila vazia, mas latência alta?** Veja a escrita do RDS (linha 5) e o outbox (linha 3).
5. **Alertas fora do padrão?** Veja a faixa esperada (linha 2) e a revisão das regras (linha 5).
6. **Entregas atrasadas?** Veja breakers e fallback (linha 6).

> As métricas do SQS e do RDS chegam com 1 a 5 min de atraso: um problema recente pode demorar a aparecer.
