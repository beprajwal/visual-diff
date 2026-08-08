/**
 * Stage 5a — node matching (spec §8).
 *
 * Nodes are paired across sides by a stable key, in strict order of trustworthiness:
 * test-id, then role plus accessible name, then DOM path. A key only pairs when it is unique on
 * both sides; ambiguous keys fall through to the next strategy rather than pairing arbitrarily,
 * because a wrong pairing invents a change that never happened.
 */

import type { DomNode, NodeKeyKind } from '../types.js';

export interface NodePair {
  key: string;
  keyKind: NodeKeyKind;
  base: DomNode | null;
  head: DomNode | null;
}

export interface NodeMatch {
  pairs: NodePair[];
  byBasePath: Map<string, NodePair>;
  byHeadPath: Map<string, NodePair>;
}

function groupBy(nodes: readonly DomNode[], key: (n: DomNode) => string | null): Map<string, DomNode[]> {
  const out = new Map<string, DomNode[]>();
  for (const n of nodes) {
    const k = key(n);
    if (k === null) continue;
    const bucket = out.get(k);
    if (bucket === undefined) out.set(k, [n]);
    else bucket.push(n);
  }
  return out;
}

function testIdKey(n: DomNode): string | null {
  return n.testId !== undefined && n.testId !== '' ? n.testId : null;
}

function roleNameKey(n: DomNode): string | null {
  const role = n.role ?? '';
  const name = n.name ?? '';
  if (role === '' || name === '') return null;
  return `${role}\u0000${name}`;
}

export function matchNodes(base: readonly DomNode[], head: readonly DomNode[]): NodeMatch {
  const pairs: NodePair[] = [];
  const usedBase = new Set<DomNode>();
  const usedHead = new Set<DomNode>();

  const pairUp = (
    keyKind: NodeKeyKind,
    key: (n: DomNode) => string | null,
    /** Pair only when the key is unique on both sides. */
    requireUnique: boolean,
  ): void => {
    const b = groupBy(base.filter((n) => !usedBase.has(n)), key);
    const h = groupBy(head.filter((n) => !usedHead.has(n)), key);
    for (const [k, baseNodes] of b) {
      const headNodes = h.get(k);
      if (headNodes === undefined) continue;
      if (requireUnique && (baseNodes.length !== 1 || headNodes.length !== 1)) continue;
      const count = Math.min(baseNodes.length, headNodes.length);
      for (let i = 0; i < count; i += 1) {
        const bn = baseNodes[i] as DomNode;
        const hn = headNodes[i] as DomNode;
        usedBase.add(bn);
        usedHead.add(hn);
        pairs.push({ key: k, keyKind, base: bn, head: hn });
      }
    }
  };

  pairUp('test-id', testIdKey, true);
  pairUp('role-name', roleNameKey, true);
  pairUp('path', (n) => n.path, false);

  for (const n of base) {
    if (usedBase.has(n)) continue;
    pairs.push({ key: n.path, keyKind: 'path', base: n, head: null });
  }
  for (const n of head) {
    if (usedHead.has(n)) continue;
    pairs.push({ key: n.path, keyKind: 'path', base: null, head: n });
  }

  const byBasePath = new Map<string, NodePair>();
  const byHeadPath = new Map<string, NodePair>();
  for (const p of pairs) {
    if (p.base !== null && !byBasePath.has(p.base.path)) byBasePath.set(p.base.path, p);
    if (p.head !== null && !byHeadPath.has(p.head.path)) byHeadPath.set(p.head.path, p);
  }

  // Document order on the head side, then base-only removals, so output is deterministic.
  const headIndex = new Map<DomNode, number>();
  head.forEach((n, i) => headIndex.set(n, i));
  const baseIndex = new Map<DomNode, number>();
  base.forEach((n, i) => baseIndex.set(n, i));
  pairs.sort((a, b) => {
    const ah = a.head === null ? Number.POSITIVE_INFINITY : (headIndex.get(a.head) as number);
    const bh = b.head === null ? Number.POSITIVE_INFINITY : (headIndex.get(b.head) as number);
    if (ah !== bh) return ah - bh;
    const ab = a.base === null ? Number.POSITIVE_INFINITY : (baseIndex.get(a.base) as number);
    const bb = b.base === null ? Number.POSITIVE_INFINITY : (baseIndex.get(b.base) as number);
    return ab - bb;
  });

  return { pairs, byBasePath, byHeadPath };
}
