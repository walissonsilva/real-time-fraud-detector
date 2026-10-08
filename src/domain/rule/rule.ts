export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RuleKind = 'STATELESS' | 'WINDOWED';
/** Ciclo de vida da versão; `mode` (ACTIVE/SHADOW) é independente (plano, dia 3). */
export type RuleStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

/** Espelha `Rule v1` (docs/contratos). A avaliação da `expression` fica atrás da porta de motor de regras (ADR-03). */
export interface Rule {
  readonly ruleId: string;
  readonly version: number;
  readonly name: string;
  readonly kind: RuleKind;
  readonly severity: Severity;
  readonly weight: number;
  readonly mode: 'ACTIVE' | 'SHADOW';
  readonly params: Readonly<Record<string, unknown>>;
  readonly expression: string;
  readonly reason: string;
}
