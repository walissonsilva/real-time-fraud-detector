// Valida os exemplos contra os schemas JSON.
//   *.valid.json   -> DEVE passar
//   *.invalid.json -> DEVE falhar
// Uso (da raiz do projeto, com `ajv` e `ajv-formats` instalados): node docs/contratos/validate-contracts.mjs
// Será reaproveitado como teste de contrato na CI (RNF-51).
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const schemas = {
  'transaction-event': 'transaction-event.v1.schema.json',
  rule: 'rule.v1.schema.json',
  'fraud-alert': 'fraud-alert.v1.schema.json',
  'alert-delivery': 'alert-delivery.v1.schema.json',
  'dlq-message': 'dlq-message.v1.schema.json',
};

const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
addFormats(ajv);
const validators = {};
for (const [name, file] of Object.entries(schemas)) validators[name] = ajv.compile(read(join(dir, file)));

let failures = 0;
const check = (label, ok, expected, errors) => {
  const pass = ok === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : '  ' + JSON.stringify(errors)}`);
};

// 1) o campo "examples" de cada schema deve ser válido
for (const [name, file] of Object.entries(schemas)) {
  const ex = read(join(dir, file)).examples ?? [];
  ex.forEach((e, i) => check(`${file} examples[${i}]`, validators[name](e), true, validators[name].errors));
}
// 2) arquivos em examples/
for (const f of readdirSync(join(dir, 'examples')).sort()) {
  const name = Object.keys(schemas).find((n) => f.startsWith(n + '.'));
  if (!name) { failures++; console.log(`FAIL  ${f}  (sem schema correspondente)`); continue; }
  const expected = f.endsWith('.valid.json');
  if (!expected && !f.endsWith('.invalid.json')) { failures++; console.log(`FAIL  ${f}  (use .valid.json ou .invalid.json)`); continue; }
  check(`examples/${f}`, validators[name](read(join(dir, 'examples', f))), expected, validators[name].errors);
}
console.log(failures ? `\n${failures} falha(s)` : '\nTodos os contratos conferem.');
process.exit(failures ? 1 : 0);
