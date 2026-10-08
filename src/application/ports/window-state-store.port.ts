/** Estado de janela para regras WINDOWED (fase 2, ADR-02). Fase 1 usa implementação em memória. */
export interface WindowStateStore {
  /** Registra o evento (idempotente por `transactionId`) e devolve a contagem na janela. */
  addAndCount(key: string, transactionId: string, occurredAtMs: number, windowMs: number): Promise<number>;
}
export const WINDOW_STATE_STORE = Symbol('WindowStateStore');
