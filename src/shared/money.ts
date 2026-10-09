/** Dinheiro sempre em unidades menores (centavos), nunca ponto flutuante (contratos §3). */
export interface Money {
  readonly minorUnits: number;
  readonly currency: string;
}
