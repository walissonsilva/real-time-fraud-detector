# Real-Time Fraud Detector

Motor de detecção de transações suspeitas em tempo real (CE 1). Decisões e requisitos em [docs/](docs/README.md).

## Estrutura (hexagonal)

```
src/
  domain/          modelos puros (sem NestJS): transaction, rule, alert
  application/
    ports/         interfaces: EventBus, RuleRepository, AlertRepository, RuleEngine, NotificationProvider, WindowStateStore
    use-cases/     orquestração (a implementar)
  infrastructure/  adaptadores: config, health, persistence (Postgres + migrações), cache (Redis), messaging (SQS/SNS)
infra/localstack/  criação das filas e tópicos (ADR-01)
```

## Execução local

```bash
npm install
npm run infra:up      # Postgres (porta 55432), Redis, LocalStack (SQS/SNS)
npm run migrate
npm run start:dev     # http://localhost:3000/health/ready
npm test              # unitários
npm run test:e2e      # requer infra:up
npm run infra:down    # remove containers e volumes
```

Configuração em `.env` (copie de `.env.example`; sem segredos reais).
