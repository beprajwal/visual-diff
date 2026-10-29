/**
 * The selector against a small Next.js-shaped repository on disk: three pages, a shared button
 * behind a barrel, a type-only import, a translation namespace, five flows. Each test is one of the
 * ways a change reaches a flow (selection spec §3), and the two things that would make the graph
 * useless — barrels and type imports — have a test each.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULTS, type SelectConfig } from '../types.js';
import { selectFlows, summarizeSelection, type FlowSelection } from './select.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const config: SelectConfig = {
  sources: ['packages/web/src'],
  pages: { router: 'next-pages', dir: 'packages/web/src/pages', basePath: '/portal' },
  aliases: { '@web/': 'packages/web/src/' },
  ignore: [...DEFAULTS.select.ignore],
  all: [
    'packages/web/src/styles/**',
    'packages/web/src/pages/_app.tsx',
    '.github/scripts/visual-diff-*',
  ],
  named: [
    {
      files: '^packages/web/src/constants/lang/[^/]+/([^/]+)\\.ts$',
      mentioned: `['"]$1['"]`,
      except: '^packages/web/src/constants/lang/',
    },
  ],
};

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vdiff-select-'));
  roots.push(root);
  const write = async (file: string, content: string): Promise<void> => {
    await mkdir(join(root, dirname(file)), { recursive: true });
    await writeFile(join(root, file), content, 'utf8');
  };
  const flow = async (name: string, routes: string[], extra = ''): Promise<void> =>
    write(
      `.visual-diff/flows/${name}.yaml`,
      `version: 1\nflow: ${name}\nbaseUrl: http://127.0.0.1:3000/\nnetwork: { mode: off }\n${extra}readyOn: http://127.0.0.1:3000/${routes[0]}\nsteps:\n${routes
        .map((route, index) => `  - id: step-${index}\n    goto: "${route}"\n`)
        .join('')}`,
    );

  await write(
    'packages/web/src/pages/shops/[id]/products/index.tsx',
    "import { Table, money } from '@web/components/table'\nimport { Button } from '@web/components/common'\n",
  );
  await write(
    'packages/web/src/pages/shops/[id]/products/[productId]/index.tsx',
    "import { History } from '@web/components/history/History'\nimport type { Row } from '@web/components/table/Table'\n",
  );
  await write(
    'packages/web/src/pages/shops/[id]/orders/index.tsx',
    "import { Button } from '@web/components/common'\nimport './orders.css'\nconst title = t('TITLE', { ns: 'orders' })\n",
  );
  await write('packages/web/src/pages/shops/[id]/orders/orders.css', '.x {}\n');
  await write('packages/web/src/pages/api/monitoring.ts', 'export default () => null\n');
  await write('packages/web/src/pages/_app.tsx', "import '@web/styles/globals.css'\n");
  await write('packages/web/src/styles/globals.css', '');
  await write(
    'packages/web/src/components/table/index.ts',
    "export { Table } from './Table'\nexport * from './cells'\n",
  );
  await write(
    'packages/web/src/components/table/Table.tsx',
    "import { Cell } from './Cell'\nexport type Row = {}\nexport const Table = () => null\n",
  );
  await write('packages/web/src/components/table/Cell.tsx', 'export const Cell = () => null\n');
  await write('packages/web/src/components/table/cells.ts', 'export const money = () => null\n');
  await write(
    'packages/web/src/components/common/index.ts',
    "export { Button } from './Button'\nexport { Toast } from './Toast'\n",
  );
  await write('packages/web/src/components/common/Button.tsx', 'export const Button = () => null\n');
  await write('packages/web/src/components/common/Toast.tsx', 'export const Toast = () => null\n');
  await write('packages/web/src/components/history/History.tsx', 'export const History = () => null\n');
  await write('packages/web/src/components/orphan/Orphan.tsx', 'export const Orphan = () => null\n');
  await write('packages/web/src/components/common/Button.test.tsx', "import { Button } from './Button'\n");
  await write(
    'packages/web/src/constants/lang/en/orders.ts',
    'export const ORDERS = { TITLE: "Orders" }\n',
  );
  await write('packages/web/src/constants/lang/en/unused.ts', 'export const UNUSED = {}\n');
  await write(
    'packages/web/src/constants/lang/resources.ts',
    "export const resources = { orders: () => import('./en/orders'), unused: () => import('./en/unused') }\nexport const names = ['orders', 'unused']\n",
  );
  await write('packages/web/src/flags/orders.ts', 'export const on = true\n');

  await flow(
    'products',
    ['shops/00000000-0000-4000-8000-000000000002/products?tab=paid'],
    'scenario: catalog\n',
  );
  await flow(
    'product-detail',
    ['${BASE_PATH}/shops/${SHOP_ID}/products/00000000-0000-4000-8000-000000000030'],
    'scenario: catalog\n',
  );
  await flow(
    'orders',
    ['/portal/shops/00000000-0000-4000-8000-000000000002/orders'],
    'covers:\n  - packages/web/src/flags/**\n',
  );
  await flow(
    'orders-local',
    ['shops/00000000-0000-4000-8000-000000000002/orders'],
    'ci: false\n',
  );
  await flow('prototype', ['/approval.html'], 'ci: false\n');
  await write(
    '.visual-diff/scenarios/catalog.yaml',
    'version: 1\nscenario: catalog\nrules:\n  - id: rows\n    match: { url: "**/rows" }\n    respond: { status: 200, body: fixtures/products.csv }\n',
  );
  await write('.visual-diff/fixtures/products.csv', 'a,b\n');
  await write('.visual-diff/config.yaml', 'app:\n  dev: x\n  readyOn: http://x\n');
  return root;
}

const select = (root: string, changed: string[], all?: string): Promise<FlowSelection> => {
  const request: Parameters<typeof selectFlows>[0] = { root, config, changed };
  if (all !== undefined) request.all = all;
  return selectFlows(request);
};

describe('selectFlows', () => {
  it('a page change selects the flows that visit that page', async () => {
    const root = await repository();
    const selection = await select(root, ['packages/web/src/pages/shops/[id]/orders/index.tsx']);
    expect(selection.mode).toBe('some');
    expect(selection.flows).toEqual(['orders']);
    expect(Object.keys(selection.skipped)).toEqual(['orders-local']);
    expect(selection.reasons['orders']?.routes).toEqual({
      '/shops/[id]/orders': ['packages/web/src/pages/shops/[id]/orders/index.tsx'],
    });
    expect(selection.warnings).toEqual([]);
  });

  it('a component change walks importers up to every page, through barrels by name', async () => {
    const root = await repository();
    expect((await select(root, ['packages/web/src/components/common/Button.tsx'])).flows).toEqual([
      'orders',
      'products',
    ]);
    // Toast sits in the same barrel as Button, but no page imports it.
    expect((await select(root, ['packages/web/src/components/common/Toast.tsx'])).mode).toBe('none');
    // Cell reaches the products page through Table and the barrel's named export.
    expect((await select(root, ['packages/web/src/components/table/Cell.tsx'])).flows).toEqual([
      'products',
    ]);
    // money is only star-exported, so the page importing it by name depends on every star module.
    expect((await select(root, ['packages/web/src/components/table/cells.ts'])).flows).toEqual([
      'products',
    ]);
    // A stylesheet imported for effect belongs to the page importing it.
    expect(
      (await select(root, ['packages/web/src/pages/shops/[id]/orders/orders.css'])).flows,
    ).toEqual(['orders']);
  });

  it('a type-only import does not make a page depend on the module', async () => {
    const root = await repository();
    // The detail page imports only `type Row` from Table, so Table reaches the products page alone.
    expect((await select(root, ['packages/web/src/components/table/Table.tsx'])).flows).toEqual([
      'products',
    ]);
    expect((await select(root, ['packages/web/src/components/history/History.tsx'])).flows).toEqual([
      'product-detail',
    ]);
  });

  it('changed and new flows, scenarios, fixtures and covers select their flows', async () => {
    const root = await repository();
    const changedFlow = await select(root, ['.visual-diff/flows/orders.yaml']);
    expect(changedFlow.flows).toEqual(['orders']);
    expect(changedFlow.reasons['orders']?.changed).toBe(true);

    // A new flow that does not parse yet still replays, so the run says what is wrong with it.
    await writeFile(join(root, '.visual-diff/flows/brand-new.yaml'), 'flow: brand-new\nsteps: []\n');
    const brandNew = await select(root, ['.visual-diff/flows/brand-new.yaml']);
    expect(brandNew.flows).toEqual(['brand-new']);
    expect(brandNew.warnings).toEqual([
      "flow 'brand-new' did not parse, so it is reached by name only — vdiff flow check brand-new",
    ]);

    // A deleted flow has nothing to run.
    expect((await select(root, ['.visual-diff/flows/gone.yaml'])).mode).toBe('none');

    // A changed ci: false flow is reported, not run.
    const local = await select(root, ['.visual-diff/flows/orders-local.yaml']);
    expect(local.mode).toBe('none');
    expect(Object.keys(local.skipped)).toEqual(['orders-local']);

    expect((await select(root, ['.visual-diff/scenarios/catalog.yaml'])).flows).toEqual([
      'product-detail',
      'products',
    ]);
    const fixture = await select(root, ['.visual-diff/fixtures/products.csv']);
    expect(fixture.flows).toEqual(['product-detail', 'products']);
    expect(fixture.reasons['products']?.fixtures).toEqual(['.visual-diff/fixtures/products.csv']);

    const flagged = await select(root, ['packages/web/src/flags/orders.ts']);
    expect(flagged.flows).toEqual(['orders']);
    expect(flagged.reasons['orders']?.covers).toEqual(['packages/web/src/flags/**']);
    expect(flagged.unattributed).toEqual([]);
  });

  it('global styles, the app shell, the harness and a caller-supplied reason replay every CI flow', async () => {
    const root = await repository();
    const everyFlow = ['orders', 'product-detail', 'products'];
    for (const file of [
      'packages/web/src/styles/globals.css',
      'packages/web/src/pages/_app.tsx',
      '.visual-diff/config.yaml',
      '.github/workflows/visual-diff.yml',
      '.github/scripts/visual-diff-select.mjs',
    ]) {
      const selection = await select(root, ['packages/web/src/components/common/Toast.tsx', file]);
      expect(selection.mode, file).toBe('all');
      expect(selection.flows, file).toEqual(everyFlow);
      expect(selection.everything, file).toContain(file);
      expect(selection.reasons).toEqual({});
    }
    const labelled = await select(root, [], 'the pull request carries the label');
    expect(labelled.mode).toBe('all');
    expect(labelled.flows).toEqual(everyFlow);
    expect(labelled.everything).toBe('the pull request carries the label');
  });

  it('replays everything when the project has no select: section', async () => {
    const root = await repository();
    const selection = await selectFlows({ root, config: undefined, changed: ['README.md'] });
    expect(selection.mode).toBe('all');
    expect(selection.everything).toBe('config.yaml has no select: section, so nothing narrows the set');
  });

  it('changes no flow reaches select nothing and are listed', async () => {
    const root = await repository();
    const selection = await select(root, [
      'README.md',
      'packages/web/src/components/common/Button.test.tsx',
      'packages/web/src/pages/api/monitoring.ts',
      'packages/web/src/components/orphan/Orphan.tsx',
    ]);
    expect(selection.mode).toBe('none');
    expect(selection.flows).toEqual([]);
    expect(selection.unattributed).toEqual(['packages/web/src/components/orphan/Orphan.tsx']);
    const summary = summarizeSelection(selection).join('\n');
    expect(summary).toMatch(/nothing replays/);
    expect(summary).toMatch(/Orphan\.tsx/);
  });

  it('a named file selects the flows of the pages that mention its name', async () => {
    const root = await repository();
    // resources.ts imports every namespace and names each one, so the import graph alone would
    // select every flow for any translation change; the rule seeds from the pages instead.
    expect((await select(root, ['packages/web/src/constants/lang/en/orders.ts'])).flows).toEqual([
      'orders',
    ]);
    const unused = await select(root, ['packages/web/src/constants/lang/en/unused.ts']);
    expect(unused.mode).toBe('none');
    expect(unused.unattributed).toEqual(['packages/web/src/constants/lang/en/unused.ts']);
  });

  it('summarises the selection as the step summary', async () => {
    const root = await repository();
    const some = await select(root, ['packages/web/src/components/common/Button.tsx']);
    expect(summarizeSelection(some)).toEqual([
      '## Visual diff flows',
      '',
      '2 flows replay.',
      '',
      '- `orders`: /shops/[id]/orders via Button.tsx',
      '- `products`: /shops/[id]/products via Button.tsx',
      '',
      'Reached but `ci: false`, so replay locally: `orders-local`.',
    ]);
    const all = await select(root, [], 'label');
    expect(summarizeSelection(all)).toEqual(['## Visual diff flows', '', 'Every flow replays: label.']);
  });
});
