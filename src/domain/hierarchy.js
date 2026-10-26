// Reconstructs the network hierarchy from each meter's own path
// (zone > circle > division > subdivision > substation > feeder > transformer).
//
// The portal's data is NOT a strict tree: below circle and above transformer,
// the same node code turns up under several different parents (e.g. D-01 sits
// under C-01, C-03 and C-05, with no majority). So the tree keeps paths exactly
// as the meters report them: a node seen under several parents appears once
// under each, counting only the meters that reached it via that path.
// `summarizeConsistency` reports how often that happens, per level.

import { LEVEL_KEYS } from './meters.js';

export function buildTree(meters) {
  const root = { level: 'network', code: null, name: 'All zones', meterCount: 0, children: new Map() };
  for (const m of meters) {
    root.meterCount++;
    let node = root;
    for (const key of LEVEL_KEYS) {
      const ref = m.network[key];
      const id = ref.code ?? `?${ref.name ?? ''}`;
      let child = node.children.get(id);
      if (!child) {
        child = { level: key, code: ref.code, name: ref.name, meterCount: 0, statusCounts: {}, children: new Map() };
        node.children.set(id, child);
      }
      child.meterCount++;
      child.statusCounts[m.status ?? 'unknown'] = (child.statusCounts[m.status ?? 'unknown'] ?? 0) + 1;
      node = child;
    }
    (node.meterIds ??= []).push(m.meterId);
  }
  const finish = (node) => {
    const children = [...node.children.values()]
      .sort((a, b) => String(a.code).localeCompare(String(b.code), 'en', { numeric: true }))
      .map(finish);
    const { children: _, ...rest } = node;
    return children.length ? { ...rest, children } : rest;
  };
  return finish(root);
}

/** Trims a tree to `depth` levels below the root (children replaced by a count). */
export function limitDepth(node, depth) {
  if (!node.children) return node;
  if (depth <= 0) {
    const { children, ...rest } = node;
    return { ...rest, childCount: children.length };
  }
  return { ...node, children: node.children.map((c) => limitDepth(c, depth - 1)) };
}

/** Per level: how many distinct nodes there are, and how many report more than one parent. */
export function summarizeConsistency(meters) {
  return LEVEL_KEYS.map((level, i) => {
    const parentsByCode = new Map();
    for (const m of meters) {
      const code = m.network[level].code;
      if (!code) continue;
      const parents = parentsByCode.get(code) ?? new Set();
      const parent = i > 0 ? m.network[LEVEL_KEYS[i - 1]].code : null;
      if (parent) parents.add(parent);
      parentsByCode.set(code, parents);
    }
    return {
      level,
      nodeCount: parentsByCode.size,
      nodesWithMultipleParents: [...parentsByCode.values()].filter((p) => p.size > 1).length,
    };
  });
}
