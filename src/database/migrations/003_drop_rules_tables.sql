-- As regras passaram a vir do AWS AppConfig (produção) e de config/rules.json (desenvolvimento), ADR-03.
-- Estas tabelas nunca foram usadas pela aplicação.

DROP TABLE IF EXISTS rule_versions;
DROP TABLE IF EXISTS rules_revision;
