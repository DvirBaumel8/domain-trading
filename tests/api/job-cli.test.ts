import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../helpers/env.js';

const run = promisify(execFile);
const cli = (args: string[]) =>
  run('npx', ['tsx', 'src/job.ts', ...args], { env: { ...process.env, ...testEnv() } });

describe('job CLI', () => {
  it('price-schedule --dry-run prints JSON and exits 0', async () => {
    const { stdout } = await cli(['price-schedule', '--dry-run', '--today', '2027-04-12']);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true, today: '2027-04-12' });
    expect(stdout).toContain('"dryRun": true');
    for (const secret of ['pk1_', 'sk1_']) expect(stdout).not.toContain(secret);
  });

  it('bad --today, no subcommand and unknown subcommand exit 2', async () => {
    await expect(cli(['price-schedule', '--today', '2027-13-01'])).rejects.toMatchObject({ code: 2 });
    await expect(cli([])).rejects.toMatchObject({ code: 2 });
    await expect(cli(['nope'])).rejects.toMatchObject({ code: 2 });
  });
});
