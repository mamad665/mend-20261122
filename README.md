# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mamad665/mend-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/mamad665/mend-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit an AI model wrote to a tree of text files, entered in the
[make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
`main.ts` is the whole tool: Node 22, standard library only, nothing installed.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file, or `-`/absent for standard input. The working
directory is the root of the tree; every path in a patch is relative to it.

## What it reads

Four formats, auto-detected (or forced with `--format=`):

- **unified** — unified diffs, even with wrong line numbers: hunks are found
  by content, nearest to the hunk's stated position. Creates, deletes and
  renames included; `\ No newline at end of file` is honoured.
- **search-replace** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks
  with the file path on the line above.
- **v4a** — `*** Begin Patch` ... `*** End Patch`, with Add / Delete / Update
  File sections, `@@` anchors, `*** Move to:` and `*** End of File` chunks.
- **json** — one JSON array of editor calls, or one call per line: `create`,
  `str_replace`, `insert`.

## Matching

Old lines are found at the first of three tiers where they occur: exact,
trailing whitespace ignored, then leading and trailing whitespace ignored
(`--strict` tries exact only). At the loose tier, added lines are re-indented
to the file's own indentation. A context line is always written as the file's
own matched line.

## Output

- Exit 0: one line per changed path (`A`/`D`/`M`, `R old -> new` for moves),
  then `ok: <n> file(s)`.
- Exit 1: one `error: <code> <path>` line per failed edit
  (`no-match`, `ambiguous`, `missing`, `exists`, `unsafe`), then
  `failed: <k> of <n> edits`. A failed edit changes nothing and the edits
  after it still run — but when any edit failed, no file is written at all.
- Exit 2: `error: usage`, `error: no-patch`, `error: format` or
  `error: parse <N>`.

`--check` reports exactly what a real run would, without writing anything.

## Practice checks

The kit's 100 public practice checks all pass against this `main.ts`:

    node check.ts <kit>/program/generator/practice.json
    # 100 of 100 passed: practice score 1000

## Files

- `main.ts` — the CLI (the entry point; also hands a trial over to the runner
  when `MAKEFUN_ENV_URL` is set).
- `runner.ts` — the kit's trial runner, unchanged.
- `check.ts` — runs `main.ts` against the kit's practice set.
