/*
 * Replays the policy over local Claude Code history and reports both branches
 * separately: the in-place shell edits and the inline read-modify-write ones.
 *
 *   node backtest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const registered = [];
globalThis.__fpReg = registered;
const shim = `
  export const customPolicies = { add: (p) => globalThis.__fpReg.push(p) };
  export const allow = (reason) => ({ decision: "allow", reason });
  export const deny = (reason) => ({ decision: "deny", reason });
  export const instruct = (reason) => ({ decision: "instruct", reason });
`;
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-guard-"));
fs.mkdirSync(path.join(shimDir, "node_modules", "failproofai"), { recursive: true });
fs.writeFileSync(
  path.join(shimDir, "node_modules", "failproofai", "package.json"),
  JSON.stringify({ name: "failproofai", version: "0.0.0", type: "module", main: "index.mjs" })
);
fs.writeFileSync(path.join(shimDir, "node_modules", "failproofai", "index.mjs"), shim);
fs.copyFileSync(new URL("./editing-policies.mjs", import.meta.url), path.join(shimDir, "p.mjs"));
await import(path.join(shimDir, "p.mjs"));
fs.rmSync(shimDir, { recursive: true, force: true });

const policy = registered[0];

// failproofai's own audit detector, as the reference set for the shell branch.
const REF_SED = /(?:^|\s|;|&&|\|\|)sed\b[^|]*\s-i(?=\b|['"])/;
const REF_AWK = /(?:^|\s|;|&&|\|\|)awk\b[^|]*\s>\s*\S+/;

// The inline rewrite shape, measured independently of the policy.
const REF_INLINE = (c) =>
  /(?:^|[\s;&|(])(?:python3?|node|bun|ruby)\s+(?:-\s*<<|-c\s|-e\s)/.test(c) &&
  /\.read_text\(\)|open\([^)]*\)\.read\(\)|readFileSync\(/.test(c) &&
  /\.replace\(|re\.sub\(/.test(c) &&
  /\.write_text\(|\.write\(|writeFileSync\(/.test(c);

const GUARDED = /\bassert\b|\bnot\s+in\b|\.count\([^)]*\)\s*[=!<>]/;

function* transcripts(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* transcripts(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

const shell = { fired: 0, quiet: 0 };
const inline = { fired: 0, quiet: 0, guardedQuiet: 0 };

for (const file of transcripts(path.join(os.homedir(), ".claude", "projects"))) {
  let lines;
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch { continue; }
  for (const line of lines) {
    if (!/sed|awk|perl|python|node|bun/.test(line)) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const command = block?.input?.command;
      if (typeof command !== "string") continue;

      const trimmed = command.trim();
      const isShell = REF_SED.test(trimmed) || (REF_AWK.test(trimmed) && !trimmed.includes("|"));
      const isInline = REF_INLINE(command);
      if (!isShell && !isInline) continue;

      const verdict = await policy.fn({ toolName: "Bash", toolInput: { command } });
      const hit = verdict.decision === "instruct";

      if (isInline) {
        if (hit) inline.fired++;
        else {
          inline.quiet++;
          if (GUARDED.test(command)) inline.guardedQuiet++;
        }
      } else if (isShell) {
        if (hit) shell.fired++;
        else shell.quiet++;
      }
    }
  }
}

console.log("in-place shell edits (sed -i / perl -i / awk > file)");
console.log(`  flagged by the reference detector : ${shell.fired + shell.quiet}`);
console.log(`  instructed                        : ${shell.fired}`);
console.log(`  left alone                        : ${shell.quiet}`);

const inlineTotal = inline.fired + inline.quiet;
console.log("\ninline read-modify-write (python / node heredoc, -c, -e)");
console.log(`  commands of this shape            : ${inlineTotal}`);
console.log(`  instructed                        : ${inline.fired} (${((inline.fired / inlineTotal) * 100).toFixed(1)}%)`);
console.log(`  left alone                        : ${inline.quiet} (${((inline.quiet / inlineTotal) * 100).toFixed(1)}%)`);
console.log(`    of those, already self-guarded  : ${inline.guardedQuiet}`);
