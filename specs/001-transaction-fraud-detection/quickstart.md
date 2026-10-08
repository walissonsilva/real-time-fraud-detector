# Quickstart — validação ponta a ponta

## Pré-requisitos

- Docker, Node.js ≥ 22, dependências instaladas (`npm ci`), `.env` copiado de `.env.example`.

## Subir a infraestrutura e a aplicação

```bash
npm run infra:up      # Postgres, Redis e LocalStack (SNS alerts.fifo + filas por canal + DLQs)
npm run migrate       # inclui 002_outbox_relay
npm run start:dev
```

## Cenários

| # | Cenário | Como exercitar | Resultado esperado |
|---|---------|----------------|--------------------|
| 1 | Alerta publicado imediatamente | Enviar à fila `transactions` um evento válido que viole uma regra | 1 linha em `alerts` e `outbox` com `published_at` preenchido; 1 mensagem em cada fila de canal; evento removido da fila |
| 2 | Sem suspeita | Evento válido que não viola regra | Nenhuma linha em `alerts`/`outbox`; evento removido |
| 3 | SNS indisponível | Parar/bloquear o SNS no LocalStack e enviar evento suspeito | Alerta e outbox gravados (pendente); evento de entrada confirmado; ao restaurar o SNS, o relay publica e `published_at` é preenchido |
| 4 | Reentrega | Enviar o mesmo evento duas vezes (e em paralelo) | Exatamente 1 alerta; nenhuma entrega repetida às filas já concluídas |
| 5 | Canal externo fora | Fazer o provedor do cliente falhar | Canal interno entregue; entrega do cliente retentada e, ao esgotar, na DLQ do canal |
| 6 | Evento inválido | Enviar JSON truncado, campo ausente, versão `2.0` | Nenhum alerta; `DlqMessage` em `transactions-dlq` com motivo e original; sem PII nos logs |

## Verificações automatizadas

```bash
npm run lint && npm test
npm run test:int            # outbox + SNS→SQS no LocalStack, falha de SNS, concorrência
npm run test:e2e
npm run contracts:validate
```

Consultas úteis: `SELECT count(*) FROM outbox WHERE published_at IS NULL;` deve voltar a 0 após a recuperação.
