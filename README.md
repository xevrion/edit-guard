# edit-guard

A policy that keeps your agent from editing source files through the shell.

```bash
failproofai policies add xevrion/edit-guard
```

`sed -i` exits 0 when its pattern matches nothing. From the agent's side a failed
edit and a successful one are identical, so the only way to find out which
happened is to read the file back, and an agent that guesses wrong starts
undoing a write that never landed. The Edit tool fails loudly on a missing
target and hands back a diff.

My own `failproofai audit` put this at 182 occurrences across 17 projects, which
made it the most common thing I do that isn't dangerous, just wasteful.

## Editing

| policy | default |
|---|---|
| `prefer-edit-over-sed` — in-place shell edits of source files (`sed -i`, `perl -pi`, `awk > file`) | on |

It's `instruct`, not `deny`. The agent can correct course by itself here, and
there are real cases where the shell is right: bulk codemods, generated files.
Blocking those strands the turn and buys nothing.

## What it leaves alone

Reads (`sed -n '1,60p'`), pipeline filters (`grep x | sed …`), piped awk, and
anything whose target is build output, a vendored tree, a lockfile, or one of
the scratch directories the harness hands the agent.

Exemptions are judged on the file operands of the edit itself, resolved against
a `cd` tracked across the command, rather than on the command string as a whole.
That distinction is the entire policy, and matching the raw string gets it wrong
in both directions:

```bash
cd /tmp/claude-1000/<session>/scratchpad && sed -i 's/a/b/' main.py   # left alone
git checkout -q main && sed -i 's/a/b/' resume.tex                    # instructed
```

The first version of this did match the whole string. It scored 13% against my
history because a `cd /tmp/…` anywhere in the line exempted everything after it.

## Testing

24 cases through failproofai's own runner, including one that replays as Codex
to prove the tool name still canonicalises to `Bash`:

```bash
node "$SKILL_DIR/scripts/test-policy.mjs" --policy editing-policies.mjs --cases cases.json
```

`backtest.mjs` replays the policy over local Claude Code history. Against mine,
using failproofai's `prefer-edit-over-sed-awk` audit detector as the reference
set: 222 flagged, 152 instructed, 70 left alone. Spot-checking both sides, the
70 are scratchpad edits, `node_modules`, and `sed -n` reads that the reference
detector over-matches.
