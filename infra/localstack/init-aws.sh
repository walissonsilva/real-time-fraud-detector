#!/bin/bash
# Executado pelo LocalStack quando fica pronto (ready.d). Cria as filas e o tópico do ADR-01.
set -euo pipefail

# Entrada: SQS padrão com DLQ (retenção de 14 dias, P-21)
awslocal sqs create-queue --queue-name transactions-dlq \
  --attributes MessageRetentionPeriod=1209600
DLQ_ARN=$(awslocal sqs get-queue-attributes --queue-url http://sqs.us-east-1.localhost.localstack.cloud:4566/000000000000/transactions-dlq \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)
awslocal sqs create-queue --queue-name transactions \
  --attributes "{\"VisibilityTimeout\":\"10\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"10\\\"}\"}"

# Saída: SNS FIFO + uma fila SQS FIFO por canal
awslocal sns create-topic --name alerts.fifo \
  --attributes FifoTopic=true,ContentBasedDeduplication=false
for channel in antifraud-queue customer-push; do
  # DLQ de entrega do canal (D-05): falhas de entrega esgotadas vão para cá como DlqMessage
  awslocal sqs create-queue --queue-name "alert-deliveries-${channel}-dlq.fifo" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600
  awslocal sqs create-queue --queue-name "alert-deliveries-${channel}.fifo" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false
  QARN="arn:aws:sqs:us-east-1:000000000000:alert-deliveries-${channel}.fifo"
  awslocal sns subscribe \
    --topic-arn arn:aws:sns:us-east-1:000000000000:alerts.fifo \
    --protocol sqs --notification-endpoint "$QARN" \
    --attributes RawMessageDelivery=true
done
echo "LocalStack: filas e tópicos criados"
