import { customPolicies, allow, instruct } from "failproofai";

/*
 * edit-guard / Editing
 *
 * `sed -i` exits 0 when its pattern matches nothing. A failed edit and a
 * successful one are byte-for-byte identical from the agent's side, so the
 * only way to find out which happened is to read the file back, and an agent
 * that guesses wrong starts "undoing" a write that never landed. The Edit
 * tool fails loudly on a missing target and hands back a diff.
 *
 * Everything here is `instruct`, never `deny`. The agent can correct course
 * on its own, and there are real cases (bulk codemods, generated files) where
 * the shell is the right tool. Blocking those strands the turn for no gain.
 *
 * Exemptions are judged on the file operands of the edit itself, resolved
 * against a `cd` tracked across the command. Matching the whole command
 * string instead gets it wrong in both directions: `cd /tmp/scratch && sed -i
 * ... main.py` is plumbing that should pass, and `git checkout main && sed -i
 * ... resume.tex` is a source edit that should not.
 */

const bashCommand = (ctx) => {
  try {
    if (!ctx || ctx.toolName !== "Bash") return "";
    const cmd = ctx.toolInput?.command;
    return typeof cmd === "string" ? cmd : "";
  } catch {
    return "";
  }
};

const segmentsOf = (cmd) =>
  cmd
    .split(/&&|\|\||[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

// Quoted spans stay whole: a sed script is one operand however much
// whitespace it contains.
const tokenize = (seg) => seg.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) ?? [];

const unquote = (t) => t.replace(/^['"]|['"]$/g, "");

// Directories where an in-place edit is plumbing rather than a source change:
// build output, vendored trees, and the scratch dirs the harness hands the
// agent. Nothing here has an Edit-tool equivalent worth steering toward.
const EXEMPT_DIR =
  /(?:^|\/)(?:node_modules|\.git|dist|build|out|\.next|vendor|target|coverage|__pycache__|\.venv)(?:\/|$)/;
const EXEMPT_ROOT = /^(?:\/tmp\/|\/var\/tmp\/|\/dev\/|\/proc\/|\/sys\/)/;
const EXEMPT_FILE =
  /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|\.min\.(?:js|css)|\.map|\.lock)$/;

const isPlumbing = (p) => EXEMPT_ROOT.test(p) || EXEMPT_DIR.test(p) || EXEMPT_FILE.test(p);

const SED = /(?:^|\/)sed$/;
const PERL = /(?:^|\/)(?:perl|ruby)$/;
const AWK = /(?:^|\/)awk$/;

// `-i`, `-i.bak`, `-ri`, `--in-place`. Long options are checked separately so
// `--include` does not read as an in-place flag.
const inPlaceFlag = (t) =>
  t.startsWith("--") ? /^--in-place/.test(t) : /^-[a-zA-Z]*i/.test(t);

/*
 * The files a segment would rewrite in place, or null when it rewrites
 * nothing. Returning [] means the command edits stdin, which has no file to
 * steer toward and is left alone.
 */
const inPlaceTargets = (seg) => {
  const tokens = tokenize(seg);
  if (!tokens.length) return null;

  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const bare = unquote(tokens[i] ?? "");
  const args = tokens.slice(i + 1);
  if (!bare) return null;

  if (SED.test(bare)) {
    if (!args.some(inPlaceFlag)) return null;
    // BSD `sed -i '' script file` takes the backup suffix as a separate empty
    // operand; dropping it keeps the script from being read as a filename.
    const operands = args.filter((t) => !t.startsWith("-") && unquote(t) !== "");
    return { tool: "sed -i", files: operands.slice(1) };
  }

  if (PERL.test(bare)) {
    if (!args.some((t) => !t.startsWith("--") && /^-[a-zA-Z]*i/.test(t))) return null;
    const files = [];
    for (let j = 0; j < args.length; j++) {
      if (args[j].startsWith("-")) {
        if (/^-[a-zA-Z]*e$/.test(args[j])) j++;
        continue;
      }
      files.push(args[j]);
    }
    return { tool: "perl -i", files };
  }

  // `awk '...' in > out` rewrites out. Piped awk is a filter and is left alone.
  if (AWK.test(bare) && />\s*\S/.test(seg)) {
    const redirect = seg.match(/>\s*(\S+)/);
    return { tool: "awk > file", files: redirect ? [redirect[1]] : [] };
  }

  return null;
};

/*
 * The same failure in a different costume: a scripting runtime invoked inline
 * to read a file, string-replace part of it, and write it back.
 *
 *   python3 - <<'EOF'
 *   p='worker/index.ts'; s=open(p).read()
 *   s=s.replace('import { env }', 'import { env, runDuration }')
 *   open(p,'w').write(s)
 *   EOF
 *
 * `str.replace` with no match returns the subject unchanged, so the file is
 * rewritten byte-identical and the process exits 0. As with `sed -i`, a failed
 * edit and a successful one are indistinguishable from the outside.
 *
 * Agents already know this. In the corpus behind this policy, 72% of these
 * carried a hand-written guard — `assert old in s` 364 times, and
 * `assert s.count(old)==1` another 362 — written precisely because `.replace`
 * cannot be trusted to have done anything. That guard is the Edit tool's
 * contract, reimplemented by hand on every call.
 *
 * So the policy stays quiet when the guard is there. Someone who has already
 * asserted the match is not making the mistake, and nagging them is how a
 * policy gets switched off.
 */
const INLINE_RUNTIME = /(?:^|[\s;&|(])(?:python3?|node|bun|ruby)\s+(?:-\s*<<|-c\s|-e\s|--eval\s)/;

const READS_A_FILE = /\.read_text\(\)|open\([^)]*\)\.read\(\)|readFileSync\(|File\.read\(/;
const REPLACES_TEXT = /\.replace\(|re\.sub\(|\.gsub[(!]/;
const WRITES_BACK = /\.write_text\(|\.write\(|writeFileSync\(|File\.write\(/;

// The shapes the agent writes when it does not trust the replace to land.
const HAS_GUARD =
  /\bassert\b|\bnot\s+in\b|\.count\([^)]*\)\s*[=!<>]|!=\s*(?:orig|before|old_s|src)\b|\braise\s+SystemExit|\bsys\.exit\(|\bprocess\.exit\(|\bthrow\s+new\b/;

const inlineRewrite = (cmd) => {
  if (!INLINE_RUNTIME.test(cmd)) return null;
  if (!READS_A_FILE.test(cmd) || !REPLACES_TEXT.test(cmd) || !WRITES_BACK.test(cmd)) return null;
  if (HAS_GUARD.test(cmd)) return null;

  const m =
    /\bp\s*=\s*['"]([^'"]+)['"]/.exec(cmd) ??
    /Path\(\s*['"]([^'"]+)['"]/.exec(cmd) ??
    /open\(\s*['"]([^'"]+)['"]/.exec(cmd) ??
    /readFileSync\(\s*['"]([^'"]+)['"]/.exec(cmd);
  return { file: m?.[1] ?? null };
};

customPolicies.add({
  name: "prefer-edit-over-sed",
  description: "Steer in-place shell edits of source files to the Edit tool",
  category: "Editing",
  defaultEnabled: true,
  match: { events: ["PreToolUse"] },
  fn: async (ctx) => {
    const raw = bashCommand(ctx);
    if (!raw) return allow();

    // A `cd` earlier in the line decides what a bare filename after it means.
    let cwd = String(ctx.session?.cwd ?? ctx.payload?.cwd ?? "");

    for (const seg of segmentsOf(raw)) {
      const cd = seg.match(/^cd\s+(['"]?)([^'"&|;]+)\1$/);
      if (cd) {
        const dir = cd[2].trim();
        cwd = dir.startsWith("/") ? dir : cwd ? `${cwd}/${dir}` : dir;
        continue;
      }

      const hit = inPlaceTargets(seg);
      if (!hit || !hit.files.length) continue;

      const source = hit.files.filter((t) => {
        const f = unquote(t);
        return !isPlumbing(f.startsWith("/") ? f : cwd ? `${cwd}/${f}` : f);
      });
      if (!source.length) continue;

      return instruct(
        `Use the Edit tool to change ${source.slice(0, 3).map(unquote).join(", ")} instead of ` +
          `\`${hit.tool}\`. An in-place shell edit exits 0 when its pattern matches nothing, so a ` +
          `failed edit looks exactly like a successful one and the only way to tell is to read ` +
          `the file back. Edit fails loudly on a missing target and returns a diff. Read the ` +
          `file, then Edit it with the exact text you expect to replace. If this really is a ` +
          `bulk codemod or a generated file, say which and go ahead.`
      );
    }

    // The heredoc form is checked against the whole command: its body spans
    // the newlines that segmentsOf splits on.
    const rewrite = inlineRewrite(raw);
    if (rewrite) {
      const target = rewrite.file;
      if (!target || !isPlumbing(target.startsWith("/") ? target : cwd ? `${cwd}/${target}` : target)) {
        return instruct(
          `Use the Edit tool to change ${target ?? "this file"} instead of reading it, ` +
            `string-replacing, and writing it back. \`.replace()\` returns the text unchanged ` +
            `when it matches nothing, so the file gets rewritten byte-identical and the script ` +
            `still exits 0. A failed edit is indistinguishable from a successful one, which is ` +
            `why this pattern usually ends up carrying a hand-written \`assert old in s\`. Edit ` +
            `does that check for you: it fails when the text is not found, and refuses rather ` +
            `than guessing when it appears more than once. Read the file, then Edit it. If you ` +
            `are generating a file rather than editing one, use Write.`
        );
      }
    }

    return allow();
  },
});
