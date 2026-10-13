# ADR-07 — Segurança, autenticação entre serviços e LGPD

> Status: **aceito**, com lacunas conhecidas listadas abaixo · Data: 12/10/2026 · Relacionada: [ADR-01](ADR-01-mensageria.md), [ADR-03](ADR-03-motor-de-regras.md), [ADR-04](ADR-04-armazenamento.md) · Requisitos: RNF-20 a RNF-30

## Contexto

O enunciado pede "segurança ponta a ponta: cripto em trânsito/repouso, autenticação entre serviços, LGPD". O serviço não expõe API de negócio: recebe eventos de uma fila SQS e publica em SNS/SQS, e os únicos endpoints HTTP (`/health/*`, `/metrics`) não são expostos fora da VPC ([OpenAPI](../contratos/openapi.v1.yaml)). Isso muda o modelo de ameaça: a fronteira de confiança é a **identidade AWS (IAM)** e a **rede privada**, não um gateway HTTP.

## Decisão

### Autenticação e autorização entre serviços: IAM, não mTLS nem OAuth2

Cada componente tem identidade própria (role IAM) e todo acesso a SQS, SNS, AppConfig, Secrets Manager e KMS é assinado com SigV4 pelo SDK. Não há credencial de longa duração: as tasks assumem a role, com `aws:SourceAccount` na política de confiança.

| Identidade | Pode | Não pode |
|---|---|---|
| **Role de execução do ECS** | Puxar imagem, escrever logs, ler **os dois** segredos da aplicação (`database_url`, `redis_url`) | Qualquer acesso a filas, tópico ou regras |
| **Role da aplicação** (`app`) | `ReceiveMessage`/`DeleteMessage`/`ChangeMessageVisibility` nas filas de entrada e de canal; `SendMessage` só nas DLQs; `sns:Publish` só em `alerts.fifo`; ler **somente** o perfil de regras no AppConfig | Publicar regras, enviar à fila de transações, administrar nada |
| **Operador de regras** (`rules-operator`) | Criar versões e iniciar/parar deployments **no perfil e ambiente de regras** | Alterar código, infraestrutura ou dados |
| **Gerador de carga** (só quando `enable_loadtest`) | Enviar à fila de transações e gerir a fila-sink `alerts-loadtest*` | Qualquer coisa fora desses recursos |
| **Produtores de transação** | `SendMessage` na fila `transactions`, listados em `transaction_producer_principals` | Ler a fila ou tocar outros recursos |

As filas de canal só aceitam `SendMessage` do tópico `alerts.fifo` (condição `aws:SourceArn`). A separação entre quem **executa** o serviço e quem **publica regras** é intencional: um comprometimento da aplicação não permite alterar regras de detecção.

### Criptografia em trânsito (RNF-20)

- **AWS SDK** (SQS, SNS, AppConfig, Secrets Manager): HTTPS. Toda fila tem política que **nega** `aws:SecureTransport = false`.
- **Postgres:** `sslmode=verify-full` na `DATABASE_URL`, com o bundle de CAs do RDS embutido na imagem (`NODE_EXTRA_CA_CERTS`) e `rds.force_ssl` no parameter group. Há validação do certificado, não só cifragem.
- **Redis:** `transit_encryption_enabled` e `auth_token`.
- **VPC:** perfil `lean` sai pela NAT (HTTPS, porta 443); perfil `full` usa *VPC endpoints* de interface, sem rota para a internet.

### Criptografia em repouso (RNF-21)

| Recurso | `lean` (testado) | `full` |
|---|---|---|
| SQS | SSE-SQS (chave gerenciada) | KMS CMK |
| SNS | `alias/aws/sns` | KMS CMK |
| RDS, Redis, Secrets Manager, CloudWatch Logs, ECR | Cifrados com chave gerenciada pela AWS | KMS CMK, com rotação anual (`enable_key_rotation`) |

A CMK dedicada (`enable_cmk`) só existe no `full`. O `lean` é cifrado em repouso, mas com chaves da AWS, sem controle de política de chave nem de rotação por conta.

### Rede

Tasks em sub-redes privadas, sem IP público e **sem nenhuma regra de entrada** no security group. O RDS não é público e só aceita 5432 das tasks; o Redis só aceita 6379 das tasks. A saída é restrita a 443 (NAT/endpoints) e às portas dos dados.

### Segredos

Strings de conexão ficam no Secrets Manager e são injetadas pelo ECS na partida. O repositório não contém segredos: `secrets.auto.tfvars` está no `.gitignore` e o `.env.example` não tem valores reais. O arquivo de estado do Terraform fica em backend remoto.

### Dados pessoais e LGPD (RNF-24, RNF-25)

- **Minimização:** o contrato de entrada não tem PAN, CPF nem nome; só tokens (`customerId`, `accountId`, `counterparty.idToken`), valor e metadados de detecção. O `summary` do alerta é mascarado.
- **Logs sem PII:** o logger aplica uma lista de chaves proibidas (`customerId`, `accountId`, `amount`, `origin`, `counterparty`, `payload`, `body`, `token`, `authorization` etc.), com profundidade limitada, e os erros viram só nome e código (`safeError`), porque a mensagem pode ecoar o evento. Há teste automatizado (`logger.spec.ts`). Métricas não carregam identificadores.
- **Notificação ao cliente:** só tipo, valor formatado, data e a orientação de confirmar ou contestar. Não inclui dados do contraparte.
- **DLQ:** guarda o evento original (pseudonimizado) por 14 dias, em fila cifrada e com acesso restrito à role da aplicação.
- **Entrada:** validação estrita por JSON Schema (Ajv); regras sem `eval` e com limite de tamanho (ADR-03).

### Cadeia de suprimentos (RNF-29)

Imagem `node:22-alpine` em dois estágios, execução como usuário `node` (não root), dependências de desenvolvimento removidas, `scan_on_push` no ECR e CloudTrail ligado nos dois perfis para auditar as ações de gerenciamento, inclusive a publicação de regras (ADR-03).

## Alternativas consideradas

| Alternativa | Por que não |
|-------------|-------------|
| mTLS entre serviços (malha de serviço ou certificados por workload) | Não há tráfego HTTP entre serviços: a comunicação é por filas, onde a identidade é a do IAM. Uma malha acrescentaria componentes sem proteger nenhum caminho real |
| OAuth2 *client credentials* com JWT curto | Só faria sentido para uma API HTTP de ingestão ou administração, que não foi implementada (ver OpenAPI) |
| API Gateway + autorizador na frente da ingestão | Mesmo motivo, e adicionaria um salto ao caminho de latência |
| Credenciais estáticas ou *secrets* em variáveis de ambiente em claro | Rotação manual e risco de vazamento em logs e no estado |

## Consequências

- Uma única malha de identidade (IAM) com auditoria nativa (CloudTrail) e sem rotação de credenciais a gerenciar.
- O serviço é **seguro por padrão a partir da rede**: sem ingress, não há superfície HTTP a proteger.
- A decisão depende de os produtores serem workloads na AWS. Um produtor fora da AWS exigiria uma borda autenticada (API Gateway ou ingestão HTTP com OAuth2/mTLS), hoje inexistente.

## Lacunas conhecidas

| # | Lacuna | Requisito | Impacto e saída |
|---|---|---|---|
| 1 | Sem mTLS nem OAuth2 (RNF-22 foi reinterpretado como IAM) | RNF-22 | Defensável pelo desenho; exigiria borda HTTP se houver produtor externo |
| 2 | `lean` sem CMK | RNF-21 | O `full` cobre; o `lean` usa chaves da AWS |
| 3 | Sem expurgo nem anonimização automática de `alerts`/`deliveries` | RNF-26 | Retenção de 5 anos (P-20) só descrita; sem job de expurgo |
| 4 | Sem índice por `customer_id` | RNF-27 | A localização por titular exigiria varredura; adicionar índice em nova migração |
| 5 | `audit_log` criada e não utilizada | RNF-28 | A auditoria cobre mudanças de regra via CloudTrail; não há mudança de status de alerta a auditar (API não implementada) |
| 6 | Sem varredura de dependências no CI (`npm audit`, Dependabot) | RNF-29 | Só a imagem é varrida no ECR; incluir `npm audit` e um bot de atualização |
| 7 | Sem rotação automática dos segredos do banco e do Redis | RNF-21 | Rotação manual; Secrets Manager suporta rotação por Lambda |
| 8 | Sem teste de acesso negado por role | RNF-22/23 | Verificado por revisão de IaC; um teste com `iam simulate-principal-policy` fecharia |

## Gatilhos de revisão

Produtor de transações fora da AWS ou implementação de uma API HTTP (adotar OAuth2 e/ou mTLS na borda), exigência regulatória de CMK em todos os perfis, ou implementação da fase 2 (Redis passa a guardar dado de janela por conta).
