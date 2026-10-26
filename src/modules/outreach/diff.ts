// A small unified diff (line based, LCS), for the company document versions. No dependency.

const CONTEXT = 3;

type Op = { t: ' ' | '-' | '+'; s: string };

function lineOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const x = a.slice(start, endA), y = b.slice(start, endB);
  const n = x.length, m = y.length, w = m + 1;
  const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
  const ops: Op[] = a.slice(0, start).map((s) => ({ t: ' ', s }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { ops.push({ t: ' ', s: x[i]! }); i++; j++; }
    else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) ops.push({ t: '-', s: x[i++]! });
    else ops.push({ t: '+', s: y[j++]! });
  }
  while (i < n) ops.push({ t: '-', s: x[i++]! });
  while (j < m) ops.push({ t: '+', s: y[j++]! });
  for (const s of a.slice(endA)) ops.push({ t: ' ', s });
  return ops;
}

/** Unified diff of two texts; the empty string when they are equal. */
export function unifiedDiff(oldText: string, newText: string, oldName: string, newName: string): string {
  if (oldText === newText) return '';
  const ops = lineOps(oldText.split('\n'), newText.split('\n'));
  const out: string[] = [`--- ${oldName}`, `+++ ${newName}`];
  const changed = ops.map((o, i) => (o.t === ' ' ? -1 : i)).filter((i) => i >= 0);
  let k = 0;
  while (k < changed.length) {
    let lo = Math.max(0, changed[k]! - CONTEXT);
    let hi = Math.min(ops.length - 1, changed[k]! + CONTEXT);
    let e = k + 1;
    while (e < changed.length && changed[e]! - CONTEXT <= hi + 1) { hi = Math.min(ops.length - 1, changed[e]! + CONTEXT); e++; }
    let oldStart = 1, newStart = 1;
    for (let i = 0; i < lo; i++) { if (ops[i]!.t !== '+') oldStart++; if (ops[i]!.t !== '-') newStart++; }
    const slice = ops.slice(lo, hi + 1);
    const oldN = slice.filter((o) => o.t !== '+').length, newN = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${oldN === 0 ? oldStart - 1 : oldStart},${oldN} +${newN === 0 ? newStart - 1 : newStart},${newN} @@`);
    for (const o of slice) out.push(`${o.t}${o.s}`);
    k = e;
    lo = hi;
  }
  return `${out.join('\n')}\n`;
}
