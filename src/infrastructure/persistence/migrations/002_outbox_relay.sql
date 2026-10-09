-- Relay do outbox: controle de tentativas, backoff e propagação de rastreamento (data-model.md).

ALTER TABLE outbox
  ADD COLUMN attempts        integer     NOT NULL DEFAULT 0,
  ADD COLUMN last_error      text,
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN traceparent     text;

DROP INDEX IF EXISTS outbox_pending_idx;
CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at) WHERE published_at IS NULL;
