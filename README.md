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

Python has the same hole. `str.replace` with no match returns the string
unchanged, so this rewrites the file byte-identical and still exits 0:

```python
python3 - <<'EOF'
p='worker/index.ts'; s=open(p).read()
s=s.replace('import { env }', 'import { env, runDuration }')
open(p,'w').write(s)
EOF
```

My own `failproofai audit` put the shell form at 182 occurrences across 17
projects. The inline form turned out to be far more common: 1,337 in the same
history, which is roughly one in twenty of every tool call I made.

## Editing

| policy | default |
|---|---|
| `prefer-edit-over-sed` — in-place shell edits (`sed -i`, `perl -pi`, `awk > file`) and inline read-modify-write (`python3 - <<EOF`, `node -e`) | on |

It's `instruct`, not `deny`. The agent can correct course by itself here, and
there are real cases where the shell is right: bulk codemods, generated files.
Blocking those strands the turn and buys nothing.

## It stays quiet when the agent already checked

The strongest evidence that this failure is real is that agents defend against
it by hand. Of 1,320 inline rewrites in my history, 72% carried a guard, and
the two most common were `assert old in s` (364 times) and
`assert s.count(old)==1` (362). That assertion is the Edit tool's contract,
reimplemented on every call.

So a guarded rewrite is left alone. Someone who has already asserted the match
is not making the mistake, and nagging them is how a policy ends up switched
off. Reads, file generation, and rewrites of scratch or build paths are also
left alone.

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

35 cases through failproofai's own runner, including one that replays as Codex
to prove the tool name still canonicalises to `Bash`:

```bash
node "$SKILL_DIR/scripts/test-policy.mjs" --policy editing-policies.mjs --cases cases.json
```

`backtest.mjs` replays the policy over local Claude Code history and reports
both branches. Against mine:

```
in-place shell edits    200 flagged, 133 instructed, 67 left alone
inline read-modify-write  1337 of this shape, 356 instructed (26.6%),
                          981 left alone, of which 961 already self-guarded
```

The shell branch uses failproofai's `prefer-edit-over-sed-awk` audit detector as
its reference set. The 67 it leaves there are scratchpad edits, `node_modules`,
and `sed -n` reads the detector over-matches.
