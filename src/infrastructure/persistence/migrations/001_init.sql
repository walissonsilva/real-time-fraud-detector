-- Esquema inicial conforme ADR-04.

CREATE TABLE alerts (
  alert_id        uuid PRIMARY KEY,
  dedupe_key      text NOT NULL UNIQUE,
  transaction_id  text NOT NULL,
  customer_id     text NOT NULL,
  account_id      text NOT NULL,
  severity        text NOT NULL,
  score           integer NOT NULL,
  rules           jsonb NOT NULL,
  summary         jsonb NOT NULL,
  degraded        boolean NOT NULL DEFAULT false,
  late            boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'OPEN',
  ingested_at     timestamptz NOT NULL,
  detected_at     timestamptz NOT NULL,
  published_at    timestamptz
);
CREATE INDEX alerts_transaction_idx ON alerts (transaction_id);
CREATE INDEX alerts_status_idx ON alerts (status, detected_at);

CREATE TABLE outbox (
  alert_id      uuid PRIMARY KEY REFERENCES alerts (alert_id),
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE deliveries (
  delivery_id  text PRIMARY KEY,
  alert_id     uuid NOT NULL REFERENCES alerts (alert_id),
  channel      text NOT NULL,
  status       text NOT NULL,
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_alert_idx ON deliveries (alert_id);

CREATE TABLE rule_versions (
  rule_id       text NOT NULL,
  version       integer NOT NULL,
  status        text NOT NULL,
  definition    jsonb NOT NULL,
  author        text NOT NULL,
  approver      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  PRIMARY KEY (rule_id, version),
  CHECK (approver IS NULL OR approver <> author)
);

-- Contador usado no polling de regras (ADR-03): uma única linha.
CREATE TABLE rules_revision (
  id        boolean PRIMARY KEY DEFAULT true CHECK (id),
  revision  bigint NOT NULL DEFAULT 0
);
INSERT INTO rules_revision DEFAULT VALUES;

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text NOT NULL,
  before     jsonb,
  after      jsonb
);

CREATE TABLE routing_policy (
  channel   text PRIMARY KEY,
  enabled   boolean NOT NULL DEFAULT true,
  config    jsonb NOT NULL DEFAULT '{}'
);
