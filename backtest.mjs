/*
 * Replays the policy over this machine's Claude Code history and reports what
 * it would have instructed on. Not part of the pack; kept here because the
 * split between a source edit and plumbing is the whole design question, and
 * unit cases alone do not show where a real corpus lands.
 *
 *   node backtest.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const registered = [];
const shim = `
  export const customPolicies = { add: (p) => globalThis.__fpReg.push(p) };
  export const allow = (reason) => ({ decision: "allow", reason });
  export const deny = (reason) => ({ decision: "deny", reason });
  export const instruct = (reason) => ({ decision: "instruct", reason });
`;
globalThis.__fpReg = registered;
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-backtest-"));
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

// failproofai's own audit detector, as the reference set to compare against.
const REF_SED = /(?:^|\s|;|&&|\|\|)sed\b[^|]*\s-i(?=\b|['"])/;
const REF_AWK = /(?:^|\s|;|&&|\|\|)awk\b[^|]*\s>\s*\S+/;

function* transcripts(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* transcripts(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

const instructed = new Map();
const allowed = new Map();

for (const file of transcripts(path.join(os.homedir(), ".claude", "projects"))) {
  let lines;
  try {
    lines = fs.readFileSync(file, "utf8").split("\n");
  } catch {
    continue;
  }
  for (const line of lines) {
    if (!line.includes("sed") && !line.includes("awk") && !line.includes("perl")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const command = block?.input?.command;
      if (typeof command !== "string") continue;
      const trimmed = command.trim();
      if (!REF_SED.test(trimmed) && !(REF_AWK.test(trimmed) && !trimmed.includes("|"))) continue;

      const verdict = await policy.fn({ toolName: "Bash", toolInput: { command } });
      const key = trimmed.slice(0, 110).replace(/\n/g, " ⏎ ");
      const bucket = verdict.decision === "instruct" ? instructed : allowed;
      bucket.set(key, (bucket.get(key) ?? 0) + 1);
    }
  }
}

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
const i = sum(instructed);
const a = sum(allowed);

console.log(`reference detector flagged : ${i + a}`);
console.log(`  instructed               : ${i} (${((i / (i + a)) * 100).toFixed(1)}%)`);
console.log(`  left alone               : ${a} (${((a / (i + a)) * 100).toFixed(1)}%)`);

const top = (m, n) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n);
console.log("\ninstructed:");
for (const [cmd, n] of top(instructed, 6)) console.log(`  ${String(n).padStart(2)}x  ${cmd}`);
console.log("\nleft alone:");
for (const [cmd, n] of top(allowed, 6)) console.log(`  ${String(n).padStart(2)}x  ${cmd}`);
