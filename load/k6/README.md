# Teste de carga k6 — latência até o alerta no SNS

Envia eventos de transação à fila `transactions` a uma taxa constante (padrão **100 TPS por 10 min**) e mede o tempo até o alerta chegar a uma fila FIFO assinante de `alerts.fifo` (criada e removida pelo próprio teste). Só uma parcela dos eventos é suspeita (padrão **1%**, dentro da faixa 0,02%–5% de `docs/pesquisa-taxa-de-alertas.md`; o valor de projeto é 0,1%).

## Pré-requisitos
```bash
npm run infra:up && npm run migrate
npm run start:dev        # app no ar, consumers habilitados
```

## Rodar
```bash
npm run load:k6                                              # 100 TPS, 10 min, 1%
RATE=5 DURATION_SECONDS=30 ALERT_RATE=0.2 npm run load:k6    # smoke
```

Variáveis: `RATE`, `DURATION_SECONDS`, `DRAIN_SECONDS` (espera final por alertas, padrão 30), `ALERT_RATE`, `MAX_VUS` (teto de VUs do produtor; padrão `max(100, 2×RATE)`; necessários ≈ RATE × tempo de resposta do envio, e o resumo mostra as iterações descartadas se faltarem), `ACCOUNTS` (padrão 500), `P95_MS` / `P99_MS` (limiares), `AWS_ENDPOINT` (padrão `http://host.docker.internal:4566`: o k6 roda em container e alcança o LocalStack publicado no host, o mesmo que o app acessa em `localhost:4566`).

## Como ler
- `alert_e2e_latency_ms`: recebimento do alerta menos `transactionOccurredAt` (carimbado no envio). Inclui fila SQS, motor, publicação e fan-out SNS→SQS.
- `alert_service_latency_ms`: `latencyMs` do próprio alerta (`publishedAt - ingestedAt`), medido pelo serviço e imune a saltos do relógio do k6. É a referência do SLO do serviço; o e2e inclui também o fan-out SNS→SQS. Os dois têm thresholds.
- O resumo final compara alertas esperados × recebidos. Cada execução grava `.txt`, `.json` e `.html` (k6-reporter) em `load/k6/results/<timestamp>` (ignorado pelo git).
- Rodando contra LocalStack, o resultado vale como regressão, não como capacidade real da AWS.
