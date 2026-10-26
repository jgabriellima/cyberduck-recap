import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from './support/imports.js';
import { isAllowedExpression } from './support/spdx.js';

const run = promisify(execFile);

interface LicensedPackage {
  readonly name: string;
  readonly versions: readonly string[];
  readonly license?: string;
}

/** pnpm runs the tests, so its own entry point is the reliable way to reach it again. */
async function productionLicenses(): Promise<
  Record<string, LicensedPackage[]>
> {
  const execPath = process.env['npm_execpath'];
  const usePnpmEntry = execPath !== undefined && /pnpm/.test(execPath);
  const [command, args] = usePnpmEntry
    ? [process.execPath, [execPath, 'licenses', 'list', '--prod', '--json']]
    : ['pnpm', ['licenses', 'list', '--prod', '--json']];
  const { stdout } = await run(command, args, {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout) as Record<string, LicensedPackage[]>;
}

describe('licence allow-list (AC-23)', () => {
  it.each([
    ['MIT', true],
    ['Apache-2.0', true],
    ['BlueOak-1.0.0', true],
    ['(MIT OR GPL-3.0-only)', true],
    ['GPL-3.0-only OR Apache-2.0', true],
    ['MIT AND ISC', true],
    ['MIT AND GPL-2.0-only', false],
    ['(MIT AND (BSD-3-Clause OR LGPL-2.1-only))', true],
    ['GPL-3.0-or-later', false],
    ['LGPL-2.1-only', false],
    ['AGPL-3.0-only', false],
    ['SSPL-1.0', false],
    ['MPL-2.0', false],
    ['EPL-2.0', false],
    ['CC-BY-SA-4.0', false],
    ['UNLICENSED', false],
    ['Unknown', false],
    ['', false],
    ['MIT OR', false],
    ['(MIT', false],
    ['Apache-2.0 WITH LLVM-exception', false],
  ])('%j is allowed: %s', (expression, allowed) => {
    expect(isAllowedExpression(expression)).toBe(allowed);
  });

  it('every production dependency, direct and transitive, has an allowed licence', async () => {
    const byLicense = await productionLicenses();
    const packages = Object.entries(byLicense).flatMap(([group, list]) =>
      list.map((pkg) => ({ ...pkg, expression: pkg.license ?? group })),
    );
    const names = packages.map((pkg) => pkg.name);
    const refused = packages
      .filter((pkg) => !isAllowedExpression(pkg.expression))
      .map((pkg) => `${pkg.name}@${pkg.versions.join(',')}: ${pkg.expression}`);

    expect(names).toContain('ssh2');
    expect(refused).toEqual([]);
  }, 30_000);
});
