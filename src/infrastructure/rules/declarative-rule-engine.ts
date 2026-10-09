import { RuleEngine, RuleMatch } from '../../application/ports/rule-engine.port';
import { Rule } from '../../domain/rule/rule';
import { TransactionEvent } from '../../domain/transaction/transaction-event';

/**
 * Avaliador do subconjunto stateless de CEL usado pelas regras (sem `eval`, sem laços):
 *   literais (número, string, true/false, lista), `tx.*`, `params.*`, `has(caminho)`,
 *   `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `&&`, `||` e parênteses.
 * Variáveis de janela (`agg.*`) e qualquer outra raiz são rejeitadas (FR-014).
 */

type Node =
  | { t: 'lit'; v: unknown }
  | { t: 'path'; root: 'tx' | 'params'; keys: string[] }
  | { t: 'has'; root: 'tx' | 'params'; keys: string[] }
  | { t: 'not'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node };

type Token = { k: 'num' | 'str' | 'id' | 'op' | 'eof'; v: string };

const OPERATORS = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '!', '(', ')', '[', ']', ',', '.'];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ k: 'num', v: m[0] });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error('string não terminada na expressão');
      out.push({ k: 'str', v: src.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0] });
      i += m[0].length;
    } else {
      const op = OPERATORS.find((o) => src.startsWith(o, i));
      if (!op) throw new Error(`caractere inesperado na expressão: '${c}'`);
      out.push({ k: 'op', v: op });
      i += op.length;
    }
  }
  out.push({ k: 'eof', v: '' });
  return out;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.or();
    if (this.peek().k !== 'eof') throw new Error(`token inesperado na expressão: '${this.peek().v}'`);
    return node;
  }

  private peek = () => this.tokens[this.pos];
  private next = () => this.tokens[this.pos++];
  private isOp(v: string) {
    return this.peek().k === 'op' && this.peek().v === v;
  }
  private isId(v: string) {
    return this.peek().k === 'id' && this.peek().v === v;
  }
  private expectOp(v: string) {
    if (!this.isOp(v)) throw new Error(`esperado '${v}' na expressão`);
    this.pos++;
  }

  private or(): Node {
    let a = this.and();
    while (this.isOp('||')) {
      this.pos++;
      a = { t: 'bin', op: '||', a, b: this.and() };
    }
    return a;
  }

  private and(): Node {
    let a = this.cmp();
    while (this.isOp('&&')) {
      this.pos++;
      a = { t: 'bin', op: '&&', a, b: this.cmp() };
    }
    return a;
  }

  private cmp(): Node {
    const a = this.unary();
    const t = this.peek();
    if ((t.k === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) || this.isId('in')) {
      this.pos++;
      return { t: 'bin', op: t.v, a, b: this.unary() };
    }
    return a;
  }

  private unary(): Node {
    if (this.isOp('!')) {
      this.pos++;
      return { t: 'not', a: this.unary() };
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.next();
    if (t.k === 'num') return { t: 'lit', v: Number(t.v) };
    if (t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'op' && t.v === '(') {
      const inner = this.or();
      this.expectOp(')');
      return inner;
    }
    if (t.k === 'op' && t.v === '[') {
      const items: unknown[] = [];
      while (!this.isOp(']')) {
        const item = this.primary();
        if (item.t !== 'lit') throw new Error('listas só aceitam literais');
        items.push(item.v);
        if (this.isOp(',')) this.pos++;
        else break;
      }
      this.expectOp(']');
      return { t: 'lit', v: items };
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') return { t: 'lit', v: t.v === 'true' };
      if (t.v === 'has' && this.isOp('(')) {
        this.pos++;
        const p = this.path(this.next());
        this.expectOp(')');
        return { t: 'has', root: p.root, keys: p.keys };
      }
      return this.path(t);
    }
    throw new Error(`token inesperado na expressão: '${t.v}'`);
  }

  private path(first: Token): { t: 'path'; root: 'tx' | 'params'; keys: string[] } {
    if (first.k !== 'id') throw new Error('esperado um caminho (tx.* ou params.*)');
    if (first.v !== 'tx' && first.v !== 'params') {
      throw new Error(`variável '${first.v}' não permitida: regras stateless só usam tx.* e params.*`);
    }
    const keys: string[] = [];
    while (this.isOp('.')) {
      this.pos++;
      const k = this.next();
      if (k.k !== 'id') throw new Error('esperado nome de campo após "."');
      keys.push(k.v);
    }
    return { t: 'path', root: first.v, keys };
  }
}

function lookup(root: unknown, keys: string[]): unknown {
  let cur = root;
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const comparable = (a: unknown, b: unknown) =>
  (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string');

function evaluate(node: Node, scope: { tx: unknown; params: unknown }): unknown {
  switch (node.t) {
    case 'lit':
      return node.v;
    case 'path':
      return lookup(scope[node.root], node.keys);
    case 'has':
      return lookup(scope[node.root], node.keys) !== undefined;
    case 'not':
      return evaluate(node.a, scope) !== true;
    case 'bin': {
      if (node.op === '&&') return evaluate(node.a, scope) === true && evaluate(node.b, scope) === true;
      if (node.op === '||') return evaluate(node.a, scope) === true || evaluate(node.b, scope) === true;
      const a = evaluate(node.a, scope);
      const b = evaluate(node.b, scope);
      if (a === undefined || b === undefined) return false;
      switch (node.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case 'in':
          return Array.isArray(b) && b.includes(a);
        case '<':
          return comparable(a, b) && (a as number) < (b as number);
        case '<=':
          return comparable(a, b) && (a as number) <= (b as number);
        case '>':
          return comparable(a, b) && (a as number) > (b as number);
        case '>=':
          return comparable(a, b) && (a as number) >= (b as number);
      }
      return false;
    }
  }
}

/** Caminhos `tx.*` lidos fora de `has()`: viram evidência. Dados de origem (IP, geo) nunca entram. */
function evidencePaths(node: Node, acc: string[][] = []): string[][] {
  if (node.t === 'path' && node.root === 'tx' && node.keys[0] !== 'origin') acc.push(node.keys);
  if (node.t === 'not') evidencePaths(node.a, acc);
  if (node.t === 'bin') {
    evidencePaths(node.a, acc);
    evidencePaths(node.b, acc);
  }
  return acc;
}

const isPrimitive = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function renderReason(template: string, tx: unknown, params: unknown): string {
  return template
    .replace(/\{(tx|params)\.([A-Za-z0-9_.]+)\}/g, (whole, root: 'tx' | 'params', path: string) => {
      const keys = path.split('.');
      if (root === 'tx' && keys[0] === 'origin') return whole;
      const value = lookup(root === 'tx' ? tx : params, keys);
      return isPrimitive(value) ? String(value) : whole;
    })
    .slice(0, 256);
}

export class DeclarativeRuleEngine implements RuleEngine {
  private readonly compiled = new Map<string, Node>();

  validate(rule: Rule): void {
    if (rule.kind !== 'STATELESS') {
      throw new Error(`regra '${rule.ruleId}': somente regras STATELESS são aceitas (sem estado nem janela)`);
    }
    if ((rule as unknown as { window?: unknown }).window !== undefined) {
      throw new Error(`regra '${rule.ruleId}': regra com janela temporal não é permitida`);
    }
    try {
      this.parsed(rule);
    } catch (err) {
      throw new Error(`regra '${rule.ruleId}': expressão inválida (${(err as Error).message})`);
    }
  }

  evaluate(rules: readonly Rule[], tx: TransactionEvent): RuleMatch[] {
    const matches: RuleMatch[] = [];
    for (const rule of rules) {
      // SHADOW avalia mas não gera alerta (rule.v1: mode)
      if (rule.mode !== 'ACTIVE') continue;
      if (!this.applies(rule, tx)) continue;
      const ast = this.parsed(rule);
      if (evaluate(ast, { tx, params: rule.params }) !== true) continue;
      const evidence: Record<string, string | number | boolean> = {};
      for (const keys of evidencePaths(ast)) {
        const value = lookup(tx, keys);
        if (isPrimitive(value)) evidence[keys.join('.')] = value;
      }
      matches.push({ rule, evidence, reason: renderReason(rule.reason, tx, rule.params) });
    }
    return matches;
  }

  private applies(rule: Rule, tx: TransactionEvent): boolean {
    const a = (rule as unknown as { appliesTo?: Record<string, string[]> }).appliesTo;
    if (!a) return true;
    return (
      (!a.transactionTypes || a.transactionTypes.includes(tx.transactionType)) &&
      (!a.channels || a.channels.includes(tx.channel)) &&
      (!a.eventTypes || a.eventTypes.includes(tx.eventType))
    );
  }

  private parsed(rule: Rule): Node {
    const key = `${rule.ruleId}:${rule.version}:${rule.expression}`;
    let ast = this.compiled.get(key);
    if (!ast) {
      ast = new Parser(tokenize(rule.expression)).parse();
      this.compiled.set(key, ast);
    }
    return ast;
  }
}
