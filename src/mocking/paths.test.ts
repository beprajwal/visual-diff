import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listScenarios, scenarioFile, scenariosDir } from './paths.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vdiff-scenario-paths-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeScenario(name: string, body = 'version: 1\n'): Promise<void> {
  await mkdir(scenariosDir(root), { recursive: true });
  await writeFile(path.join(scenariosDir(root), name), body, 'utf8');
}

describe('scenario file layout (mocking spec §5 "Storage")', () => {
  it('puts scenarios beside flows under .visual-diff', () => {
    expect(scenariosDir('/project')).toBe('/project/.visual-diff/scenarios');
  });

  it('names one scenario file after the scenario', () => {
    expect(scenarioFile('/project', 'empty-forecast')).toBe(
      '/project/.visual-diff/scenarios/empty-forecast.yaml',
    );
  });

  it('normalizes a root with a trailing separator rather than doubling it', () => {
    expect(scenarioFile('/project/', 'offline')).toBe(
      '/project/.visual-diff/scenarios/offline.yaml',
    );
  });
});

describe('listScenarios', () => {
  it('is empty for a project that has never written a scenario, not an error', async () => {
    await expect(listScenarios(root)).resolves.toEqual([]);
  });

  it('is empty for an existing but empty scenarios directory', async () => {
    await mkdir(scenariosDir(root), { recursive: true });
    await expect(listScenarios(root)).resolves.toEqual([]);
  });

  it('lists scenario names sorted, without their extension', async () => {
    await writeScenario('offline.yaml');
    await writeScenario('empty-forecast.yaml');
    await expect(listScenarios(root)).resolves.toEqual(['empty-forecast', 'offline']);
  });

  it('accepts .yml as well as .yaml', async () => {
    await writeScenario('slow-air.yml');
    await expect(listScenarios(root)).resolves.toEqual(['slow-air']);
  });

  it('ignores files that are not YAML', async () => {
    await writeScenario('empty-forecast.yaml');
    await writeScenario('README.md');
    await writeScenario('weather.har');
    await expect(listScenarios(root)).resolves.toEqual(['empty-forecast']);
  });

  it('ignores a directory that happens to end in .yaml', async () => {
    await mkdir(path.join(scenariosDir(root), 'nested.yaml'), { recursive: true });
    await writeScenario('real.yaml');
    await expect(listScenarios(root)).resolves.toEqual(['real']);
  });

  it('ignores a bare extension with no name in front of it', async () => {
    await writeScenario('.yaml');
    await expect(listScenarios(root)).resolves.toEqual([]);
  });

  /**
   * The `list` command turns an unusable file into a warning naming it. That only works if the file
   * reaches the command, so listing keeps names that could never be *selected* — a scenario present
   * on disk but absent from the listing is indistinguishable from one that was never written.
   */
  it('lists the reserved name so the caller can report why it cannot be used', async () => {
    await writeScenario('none.yaml');
    await expect(listScenarios(root)).resolves.toEqual(['none']);
  });

  it('lists a symlinked scenario file rather than skipping it silently', async () => {
    const outside = path.join(root, 'shared.yaml');
    await writeFile(outside, 'version: 1\n', 'utf8');
    await mkdir(scenariosDir(root), { recursive: true });
    await symlink(outside, path.join(scenariosDir(root), 'shared.yaml'));
    await expect(listScenarios(root)).resolves.toEqual(['shared']);
  });
});
