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

    return allow();
  },
});
