// Valida um documento de regras (RulesDocument v1) com a mesma função usada pelas instâncias.
//   ts-node scripts/rules/validate-rules.ts <arquivo.json>
// Saída: "OK <n> regras" (código 0) ou a mensagem do erro, sem valores do documento (código 1).
import { readFileSync } from 'node:fs';
import { DeclarativeRuleEngine } from '../../src/rules/declarative-rule-engine';
import { RulesConfigError, validateRulesDocument } from '../../src/rules/rules-document.validator';

const file = process.argv[2];
if (!file) {
  console.error('uso: ts-node scripts/rules/validate-rules.ts <arquivo.json>');
  process.exit(2);
}

try {
  const { rules } = validateRulesDocument(readFileSync(file, 'utf8'), { engine: new DeclarativeRuleEngine() });
  console.log(`OK ${rules.length} regras`);
} catch (err) {
  console.error(err instanceof RulesConfigError ? err.message : `não foi possível validar ${file}`);
  process.exit(1);
}
