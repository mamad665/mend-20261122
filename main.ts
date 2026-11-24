// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four shapes — unified diff, SEARCH/REPLACE blocks,
// V4A, or JSON editor calls — finds the lines each edit names even when the
// file has drifted in whitespace or indentation, and writes every change or
// none at all. Run as `node main.ts [options] [PATCH]` with the working
// directory as the root of the tree. Node 22, standard library only.
//
// The contract is SPEC.md: exit 0 lists what changed, exit 1 lists which
// edits failed and why, exit 2 is a usage, missing-patch, format or parse
// problem. Standard error is never part of the answer.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch the reader cannot read: exit 2, `error: parse <line>`. */
class ParseFault extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

/** One edit that cannot be applied: exit 1, `error: <code> <path>`. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` off each, no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as lines plus the facts needed to write it back the same way. */
interface Doc {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.finalBreak ? d.br : '');
}

/** The tree as the edits leave it: `now` holds what changed (null: deleted). */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<{ from: string; to: string }> = [];

  original(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

function needSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFault('unsafe', p);
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** One line at a matching tier: 0 exact, 1 trailing space/tab off, 2 both ends off. */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

interface Occurrence {
  tier: number;
  at: number[];
}

/** The first tier at which `pat` occurs in `lines` (from `from`), with every position there. */
function findOccurrences(lines: string[], pat: string[], strict: boolean, from = 0): Occurrence | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at: number[] = [];
    for (let i = from; i + pat.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < pat.length; j++) {
        if (norm(lines[i + j]!, tier) !== norm(pat[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** First line at or after `from` equal to `anchor` at the first tier with one. */
function findSingle(lines: string[], anchor: string, strict: boolean, from: number): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (norm(lines[i]!, tier) === norm(anchor, tier)) return i;
    }
  }
  return -1;
}

/** One line of an old block or a new block. `ctx` lines sit in both. */
interface PatchLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
  fromEmpty?: boolean;
}

/**
 * The new lines of a replacement. A context line is written as the file's own
 * matched line, never the patch's. At tier 2 every other line that starts with
 * the old block's leading whitespace has that whitespace swapped for the
 * file's; at tiers 0 and 1 new lines are written as they are.
 */
function buildNew(fileLines: string[], pos: number, oldItems: PatchLine[], newItems: PatchLine[], tier: number): string[] {
  const oldCtx: number[] = [];
  oldItems.forEach((it, idx) => {
    if (it.kind === 'ctx') oldCtx.push(idx);
  });
  let seen = 0;
  const pLead = oldItems.length > 0 ? leadingWs(oldItems[0]!.text) : '';
  const fLead = leadingWs(fileLines[pos]!);
  return newItems.map((it) => {
    if (it.kind === 'ctx') {
      const oi = oldCtx[seen]!;
      seen += 1;
      return fileLines[pos + oi]!;
    }
    if (tier === 2 && it.text !== '' && it.text.trim() !== '' && it.text.startsWith(pLead)) {
      return fLead + it.text.slice(pLead.length);
    }
    return it.text;
  });
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                    */
/* ------------------------------------------------------------------ */

interface Hunk {
  start: number;
  body: PatchLine[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  hasDash: boolean;
  dashOld: string | null;
  dashNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `---`/`+++` path: up to the first tab, spaces off, a leading `a/` or `b/` off. */
function dashPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function lastCtxOrNew(body: PatchLine[]): PatchLine | null {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind !== 'old') return body[i]!;
  }
  return null;
}

function hunkOldLen(h: Hunk): number {
  return h.body.filter((b) => b.kind !== 'new').length;
}

function hunkNewLen(h: Hunk): number {
  return h.body.filter((b) => b.kind !== 'old').length;
}

/** One hunk onto a document; `d` is the line drift of this section's earlier hunks. */
function applyHunk(doc: Doc, hunk: Hunk, d: number, strict: boolean, path: string): Doc {
  const oldItems = hunk.body.filter((b) => b.kind !== 'new');
  const newItems = hunk.body.filter((b) => b.kind !== 'old');
  if (oldItems.length === 0) {
    const at = Math.min(Math.max(hunk.start + d, 0), doc.lines.length);
    const lines = [...doc.lines];
    lines.splice(at, 0, ...newItems.map((b) => b.text));
    let finalBreak = doc.finalBreak;
    if (at === doc.lines.length) {
      const last = lastCtxOrNew(hunk.body);
      finalBreak = last === null ? true : !last.noNl;
    }
    return { lines, br: doc.br, finalBreak };
  }
  const occ = findOccurrences(doc.lines, oldItems.map((b) => b.text), strict);
  if (occ === null) throw new EditFault('no-match', path);
  const target = hunk.start - 1 + d;
  let pos = occ.at[0]!;
  let best = Math.abs(pos - target);
  for (const p of occ.at) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const made = buildNew(doc.lines, pos, oldItems, newItems, occ.tier);
  const lines = [...doc.lines];
  lines.splice(pos, oldItems.length, ...made);
  let finalBreak = doc.finalBreak;
  if (pos + oldItems.length === doc.lines.length) {
    const last = lastCtxOrNew(hunk.body);
    finalBreak = last === null ? true : !last.noNl;
  }
  return { lines, br: doc.br, finalBreak };
}

/** The `+` lines of a creation's hunks, with a final break unless the last one is marked none. */
function creationText(hunks: Hunk[]): string {
  const plus: PatchLine[] = [];
  for (const h of hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b);
  if (plus.length === 0) return '';
  const last = plus[plus.length - 1]!;
  return plus.map((b) => b.text).join('\n') + (last.noNl ? '' : '\n');
}

function parseHunk(lines: string[], i: number): [Hunk, number] {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (m === null) throw new ParseFault(i + 1);
  const hunk: Hunk = { start: parseInt(m[1]!, 10), body: [] };
  const n = lines.length;
  i += 1;
  while (i < n) {
    const line = lines[i]!;
    if (line === '') {
      hunk.body.push({ kind: 'ctx', text: '', noNl: false, fromEmpty: true });
      i += 1;
      continue;
    }
    const c = line[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      if (c === '-' && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      hunk.body.push({
        kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new',
        text: line.slice(1),
        noNl: false,
      });
      i += 1;
      continue;
    }
    if (c === '\\') {
      const last = hunk.body[hunk.body.length - 1];
      if (last !== undefined) last.noNl = true;
      i += 1;
      continue;
    }
    break;
  }
  while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.fromEmpty === true) hunk.body.pop();
  return [hunk, i];
}

/** A section's header and hunks, up to the next section or the end of the patch. */
function parseSection(lines: string[], i: number, s: Section): number {
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const [hunk, next] = parseHunk(lines, i);
      s.hunks.push(hunk);
      i = next;
      continue;
    }
    if (s.hunks.length === 0) {
      if (line.startsWith('diff --git ')) return i;
      if (line.startsWith('--- ')) {
        const nx = lines[i + 1] ?? '';
        if (!nx.startsWith('+++ ')) throw new ParseFault(i + 2);
        if (s.hasDash) return i;
        s.dashOld = dashPath(line.slice(4));
        s.dashNew = dashPath(nx.slice(4));
        s.hasDash = true;
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (s.renameOld === null) s.renameOld = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (s.renameNew === null) s.renameNew = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        s.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        s.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    i += 1;
  }
  return i;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+?)\s*$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      const s: Section = {
        gitOld: m[1]!, gitNew: m[2]!, hasDash: false, dashOld: null, dashNew: null,
        renameOld: null, renameNew: null, newFile: false, deletedFile: false, hunks: [],
      };
      sections.push(s);
      i = parseSection(lines, i + 1, s);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s: Section = {
        gitOld: null, gitNew: null, hasDash: false, dashOld: null, dashNew: null,
        renameOld: null, renameNew: null, newFile: false, deletedFile: false, hunks: [],
      };
      sections.push(s);
      i = parseSection(lines, i, s);
      continue;
    }
    if (line.startsWith('@@')) throw new ParseFault(i + 1);
    i += 1;
  }
  return sections.map(sectionEdit);
}

function sectionEdit(s: Section): Edit {
  const oldPath = s.hasDash ? s.dashOld : (s.renameOld ?? s.gitOld);
  const newPath = s.hasDash ? s.dashNew : (s.renameNew ?? s.gitNew);
  const isCreate = s.newFile || (oldPath === null && newPath !== null);
  const isDelete = s.deletedFile || (newPath === null && oldPath !== null);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  return (tree, strict) => {
    if (isCreate) {
      const p = newPath!;
      needSafe(p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.set(p, creationText(s.hunks));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      needSafe(p);
      if (tree.get(p) === null) throw new EditFault('missing', p);
      tree.set(p, null);
      return;
    }
    if (isMove) {
      const from = oldPath!;
      const to = newPath!;
      needSafe(from);
      needSafe(to);
      const before = tree.get(from);
      if (before === null) throw new EditFault('missing', from);
      if (tree.get(to) !== null) throw new EditFault('exists', to);
      let doc = readDoc(before);
      let d = 0;
      for (const h of s.hunks) {
        doc = applyHunk(doc, h, d, strict, from);
        d += hunkNewLen(h) - hunkOldLen(h);
      }
      tree.set(from, null);
      tree.set(to, writeDoc(doc));
      tree.moves.push({ from, to });
      return;
    }
    const p = oldPath ?? newPath ?? '';
    needSafe(p);
    const before = tree.get(p);
    if (before === null) throw new EditFault('missing', p);
    let doc = readDoc(before);
    let d = 0;
    for (const h of s.hunks) {
      doc = applyHunk(doc, h, d, strict, p);
      d += hunkNewLen(h) - hunkOldLen(h);
    }
    tree.set(p, writeDoc(doc));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                            */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SrBlock[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (isBlank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchLine + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let k = i + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new ParseFault(searchLine + 1);
    let rep = -1;
    for (let k = eq + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseFault(searchLine + 1);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b));
}

function srEdit(b: SrBlock): Edit {
  return (tree, strict) => {
    needSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new EditFault('exists', b.path);
      tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new EditFault('missing', b.path);
    const doc = readDoc(before);
    const occ = findOccurrences(doc.lines, b.oldLines, strict);
    if (occ === null) throw new EditFault('no-match', b.path);
    if (occ.at.length > 1) throw new EditFault('ambiguous', b.path);
    const pos = occ.at[0]!;
    const oldItems: PatchLine[] = b.oldLines.map((t) => ({ kind: 'ctx', text: t, noNl: false }));
    const newItems: PatchLine[] = b.newLines.map((t) => ({ kind: 'new', text: t, noNl: false }));
    const made = buildNew(doc.lines, pos, oldItems, newItems, occ.tier);
    const next = [...doc.lines];
    next.splice(pos, b.oldLines.length, ...made);
    tree.set(b.path, writeDoc({ lines: next, br: doc.br, finalBreak: doc.finalBreak }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                      */
/* ------------------------------------------------------------------ */

interface Chunk {
  anchor: string | null;
  items: PatchLine[];
  eof: boolean;
}

const V4A_STARTS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];

function isV4aSectionStart(line: string): boolean {
  return V4A_STARTS.some((p) => line.startsWith(p));
}

function v4aBodyLine(text: string): PatchLine {
  if (text === '') return { kind: 'ctx', text: '', noNl: false };
  const c = text[0]!;
  if (c === ' ') return { kind: 'ctx', text: text.slice(1), noNl: false };
  if (c === '-') return { kind: 'old', text: text.slice(1), noNl: false };
  return { kind: 'new', text: text.slice(1), noNl: false };
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const path = line.slice(line.indexOf(': ') + 2).trim();
      const headNo = i + 1;
      i += 1;
      const raw: Array<{ text: string; no: number }> = [];
      while (i < last) {
        const l = lines[i]!;
        if (isV4aSectionStart(l)) break;
        raw.push({ text: l, no: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
      if (kind === 'add') {
        const content: string[] = [];
        for (const r of raw) {
          if (r.text.startsWith('+')) content.push(r.text.slice(1));
          else if (r.text === '') content.push('');
          else throw new ParseFault(r.no);
        }
        edits.push((tree) => {
          needSafe(path);
          if (tree.get(path) !== null) throw new EditFault('exists', path);
          tree.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
        });
      } else if (kind === 'delete') {
        for (const r of raw) throw new ParseFault(r.no);
        edits.push((tree) => {
          needSafe(path);
          if (tree.get(path) === null) throw new EditFault('missing', path);
          tree.set(path, null);
        });
      } else {
        let j = 0;
        let skip = 0;
        while (skip < raw.length && isBlank(raw[skip]!.text)) skip += 1;
        let moveTo: string | null = null;
        if (skip < raw.length && raw[skip]!.text.startsWith('*** Move to: ')) {
          moveTo = raw[skip]!.text.slice('*** Move to: '.length).trim();
          j = skip + 1;
        }
        const chunks: Chunk[] = [];
        let cur: Chunk | null = null;
        while (j < raw.length) {
          const r = raw[j]!;
          if (r.text.startsWith('@@')) {
            if (cur !== null) chunks.push(cur);
            const anchor = r.text.slice(2).trim();
            cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
            j += 1;
            continue;
          }
          if (r.text === '*** End of File') {
            if (cur === null) throw new ParseFault(r.no);
            cur.eof = true;
            chunks.push(cur);
            cur = null;
            j += 1;
            continue;
          }
          if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
            if (cur === null) {
              if (chunks.length > 0) throw new ParseFault(r.no);
              cur = { anchor: null, items: [], eof: false };
            }
            cur.items.push(v4aBodyLine(r.text));
            j += 1;
            continue;
          }
          throw new ParseFault(r.no);
        }
        if (cur !== null) chunks.push(cur);
        if (chunks.length === 0 && moveTo === null) throw new ParseFault(headNo);
        edits.push(v4aUpdateEdit(path, moveTo, chunks));
      }
      continue;
    }
    throw new ParseFault(i + 1);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[]): Edit {
  return (tree, strict) => {
    needSafe(path);
    if (moveTo !== null) needSafe(moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    let doc = readDoc(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const idx = findSingle(doc.lines, ch.anchor, strict, cursor);
        if (idx < 0) throw new EditFault('no-match', path);
        cursor = idx + 1;
      }
      const oldItems = ch.items.filter((b) => b.kind !== 'new');
      const newItems = ch.items.filter((b) => b.kind !== 'old');
      if (oldItems.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const next = [...doc.lines];
        next.splice(at, 0, ...newItems.map((b) => b.text));
        doc = { lines: next, br: doc.br, finalBreak: doc.finalBreak };
        cursor = at + newItems.length;
        continue;
      }
      const occ = findOccurrences(doc.lines, oldItems.map((b) => b.text), strict, cursor);
      if (occ === null) throw new EditFault('no-match', path);
      let positions = occ.at;
      if (ch.eof) positions = positions.filter((p) => p + oldItems.length === doc.lines.length);
      if (positions.length === 0) throw new EditFault('no-match', path);
      const pos = positions[0]!;
      const made = buildNew(doc.lines, pos, oldItems, newItems, occ.tier);
      const next = [...doc.lines];
      next.splice(pos, oldItems.length, ...made);
      doc = { lines: next, br: doc.br, finalBreak: doc.finalBreak };
      cursor = pos + made.length;
    }
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, out);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                       */
/* ------------------------------------------------------------------ */

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      needSafe(p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        count += 1;
        if (at < 0) at = k;
      }
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      needSafe(p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const doc = readDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFault('no-match', p);
      const next = [...doc.lines];
      next.splice(lineNo, 0, ...add);
      tree.set(p, writeDoc({ lines: next, br: doc.br, finalBreak: doc.finalBreak }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(i + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection, the command line, and the run (SPEC sections 1-4, 10) */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function parsePatch(kind: string, text: string, lines: string[]): Edit[] {
  if (kind === 'json') return parseJson(text, lines);
  if (kind === 'unified') return parseUnified(lines);
  if (kind === 'search-replace') return parseSearchReplace(lines);
  return parseV4a(lines);
}

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = parsePatch(kind, text, lines);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const savedNow = new Map(tree.now);
    const savedMoves = [...tree.moves];
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of savedNow) tree.now.set(k, v);
      tree.moves = savedMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.from);
    const nowOld = tree.get(m.from);
    const wasNew = tree.original(m.to);
    const nowNew = tree.get(m.to);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      covered.add(m.from);
      covered.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
