import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

let script: string;
beforeAll(async () => {
  const action = parse(await readFile(new URL('../../action.yml', import.meta.url), 'utf8'));
  script = action.runs.steps.find((step: { name: string }) => step.name === 'Post the comment').with.script;
});

interface PostedComment { id: number; body: string; user: { login: string } }
const marker = (flow: string) => `<!-- vdiff:${flow}:pr -->`;
const summaryMarker = '<!-- vdiff:unchanged-flows:agent,data-table -->';
const previous = (id: number, body: string, login = 'visual-diff[bot]'): PostedComment => ({ id, body, user: { login } });

async function post(flows: Record<string, boolean | undefined>, existing: PostedComment[] = []) {
  const files = new Map<string, string>();
  for (const [flow, unchanged] of Object.entries(flows)) {
    files.set(`/bundle/${flow}/comment.md`, `${marker(flow)}\n${flow} report`);
    if (unchanged !== undefined) files.set(`/bundle/${flow}/comment.json`, JSON.stringify({ data: { unchanged } }));
  }
  const issues = {
    listComments: vi.fn(),
    createComment: vi.fn(async () => ({ data: { id: 100 } })),
    updateComment: vi.fn(async () => ({})),
    deleteComment: vi.fn(async () => ({})),
  };
  await runInNewContext(`(async () => { ${script}\n })()`, {
    require: (name: string) => name === 'node:path' ? path : {
      existsSync: (file: string) => files.has(file),
      readFileSync: (file: string) => {
        const contents = files.get(file);
        if (contents === undefined) throw new Error(`Missing file: ${file}`);
        return contents;
      },
    },
    github: { paginate: async () => existing, rest: { issues } },
    context: { payload: { pull_request: { number: 4584 } }, repo: { owner: 'krane-tech', repo: 'apps' } },
    process: { env: { FLOWS: Object.keys(flows).join(' '), BUNDLE_ROOT: '/bundle', APP_SLUG: 'visual-diff', REPORT_BASE: 'https://example.test/reports' } },
    core: { info: vi.fn(), warning: vi.fn() },
  });
  return issues;
}

describe('CI comment publishing', () => {
  it('posts one small text comment for all unchanged flows', async () => {
    const issues = await post({ agent: true, 'data-table': true });
    expect(issues.createComment).toHaveBeenCalledTimes(1);
    expect(issues.createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: `${summaryMarker}\n**Visual Diff:** No visual changes above configured thresholds in 2 flows: [agent](https://example.test/reports/agent/report.html), [data-table](https://example.test/reports/data-table/report.html).\n`,
    }));
  });

  it('replaces old per-flow reports with one summary and leaves other comments alone', async () => {
    const issues = await post({ agent: true, 'data-table': true }, [
      previous(1, `${marker('agent')}\nOld large report`),
      previous(2, `${marker('data-table')}\nOld large report`),
      previous(3, `${marker('another-flow')}\nAnother job`),
      previous(4, `Please check this: ${marker('agent')}`, 'reviewer'),
    ]);
    expect(issues.createComment).toHaveBeenCalledTimes(1);
    expect(issues.deleteComment.mock.calls).toEqual([
      [{ owner: 'krane-tech', repo: 'apps', comment_id: 1 }],
      [{ owner: 'krane-tech', repo: 'apps', comment_id: 2 }],
    ]);
  });

  it('updates the same summary on reruns, even if flow order changes', async () => {
    const issues = await post({ 'data-table': true, agent: true }, [previous(5, `${summaryMarker}\nPrevious summary`)]);
    expect(issues.updateComment).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 5 }));
    expect(issues.createComment).not.toHaveBeenCalled();
    expect(issues.deleteComment).not.toHaveBeenCalled();
  });

  it('keeps changed flow reports while summarizing the unchanged flows', async () => {
    const issues = await post({ agent: false, 'data-table': true }, [previous(5, `${summaryMarker}\nPreviously all clean`)]);
    expect(issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ body: `${marker('agent')}\nagent report` }));
    expect(issues.updateComment).toHaveBeenCalledWith(expect.objectContaining({
      comment_id: 5,
      body: expect.stringContaining('in 1 flow: [data-table]'),
    }));
  });

  it('removes the obsolete clean summary when every flow has changes', async () => {
    const issues = await post({ agent: false, 'data-table': false }, [previous(5, `${summaryMarker}\nPreviously clean`)]);
    expect(issues.createComment).toHaveBeenCalledTimes(2);
    expect(issues.deleteComment).toHaveBeenCalledWith({ owner: 'krane-tech', repo: 'apps', comment_id: 5 });
  });

  it('keeps the normal report when an older CLI provides no unchanged verdict', async () => {
    const issues = await post({ agent: undefined });
    expect(issues.createComment).toHaveBeenCalledWith(expect.objectContaining({ body: `${marker('agent')}\nagent report` }));
  });

  it('preserves the configured bot identity when replacing an existing summary', async () => {
    const issues = await post({ agent: true, 'data-table': true }, [previous(5, `${summaryMarker}\nOld identity`, 'github-actions[bot]')]);
    expect(issues.deleteComment).toHaveBeenCalledWith({ owner: 'krane-tech', repo: 'apps', comment_id: 5 });
    expect(issues.createComment).toHaveBeenCalledTimes(1);
    expect(issues.updateComment).not.toHaveBeenCalled();
  });
});
