import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

describe('contratos (docs/contratos)', () => {
  it('schemas, exemplos e OpenAPI conferem', () => {
    const root = join(__dirname, '../..');
    const res = spawnSync('node', ['docs/contratos/validate-contracts.mjs'], { cwd: root, encoding: 'utf8' });
    const failures = res.stdout.split('\n').filter((l) => l.startsWith('FAIL'));
    expect(failures).toEqual([]);
    expect(res.status).toBe(0);
  });
});
