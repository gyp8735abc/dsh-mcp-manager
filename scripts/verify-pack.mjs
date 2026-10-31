#!/usr/bin/env node
// Verify what `npm publish` would upload, before it uploads it.
//
// Checks:
//   1. the files npm would pack include every runtime file and both READMEs;
//   2. nothing from the repository (tests, scripts, docs, node_modules) sneaks in;
//   3. package.json carries the fields dsh needs to load and describe the bundle.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const required = [
  "package.json",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/skill-filter.js",
  "lib/skill-roots.js",
  "client/client.js",
  "locale/en.json",
  "locale/zh.json",
  "icon.svg",
  "README.md",
  "README.zh.md",
  "LICENSE",
];
const forbiddenPrefixes = ["node_modules/", "scripts/", "docs/", "test/", ".github/", "src/"];

const problems = [];
const field = (value, label) => {
  if (value === undefined || value === null || value === "") problems.push(`package.json: ${label} is missing`);
};
field(manifest.name, "name");
field(manifest.version, "version");
field(manifest.description, "description");
field(manifest.icon, "icon");
field(manifest.license, "license");
field(manifest.exports?.["./client"], "exports['./client']");
field(manifest.exports?.["./locale/*.json"], "exports['./locale/*.json']");
field(manifest.dsh?.bundle?.patch, "dsh.bundle.patch");
field(manifest.dsh?.client?.platform, "dsh.client.platform");
if (manifest.dsh?.manifestVersion !== 1) problems.push("package.json: dsh.manifestVersion must be 1");
if (manifest.private === true) problems.push("package.json: private is true, npm will refuse to publish");
if (manifest.name?.startsWith("@") && manifest.publishConfig?.access !== "public") {
  problems.push("package.json: a scoped package needs publishConfig.access = \"public\"");
}
if (manifest.engines?.dsh === undefined && manifest.peerDependencies?.["@deepseek-ai/dsh-mcp-client"] === undefined) {
  problems.push("package.json: declare engines.dsh or a @deepseek-ai/dsh-* peer so DSH can check compatibility");
}

/** Ask npm what it would pack. `--report <file>` replays a saved report where spawning npm is blocked. */
function packReport() {
  const flagIndex = process.argv.indexOf("--report");
  if (flagIndex >= 0 && process.argv[flagIndex + 1] !== undefined) {
    return readFileSync(resolve(process.argv[flagIndex + 1]), "utf8").replace(/^\uFEFF/, "");
  }
  // A repository-local cache keeps `npm pack` working under a sandboxed shell and in CI.
  const cache = join(root, ".npm-cache-pack");
  mkdirSync(cache, { recursive: true });
  const pack = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    // npm is a .cmd shim on Windows, which needs a shell to spawn.
    shell: true,
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false" },
  });
  if (pack.error !== undefined) {
    console.error(`verify-pack: could not run npm (${String(pack.error)}).`);
    console.error("verify-pack: in a sandboxed shell, run this instead:");
    console.error("  npm pack --dry-run --json | Out-File -Encoding utf8NoBOM .pack.json");
    console.error("  node scripts/verify-pack.mjs --report .pack.json");
    process.exit(1);
  }
  if (pack.status !== 0) {
    console.error("verify-pack: `npm pack --dry-run` failed");
    console.error(pack.stderr || pack.stdout);
    process.exit(1);
  }
  return pack.stdout;
}

let report;
try {
  report = JSON.parse(packReport());
} catch (error) {
  console.error(`verify-pack: could not read the npm pack report: ${String(error)}`);
  process.exit(1);
}

const files = (report[0]?.files ?? []).map((entry) => entry.path.replaceAll("\\", "/"));
for (const file of required) {
  if (!files.includes(file)) problems.push(`missing from the tarball: ${file}`);
}
for (const file of files) {
  const prefix = forbiddenPrefixes.find((candidate) => file.startsWith(candidate));
  if (prefix !== undefined) problems.push(`unexpected file in the tarball: ${file}`);
}

if (problems.length > 0) {
  console.error("verify-pack: the package is not publish-ready:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const size = report[0]?.unpackedSize ?? 0;
console.log(`verify-pack: ok — ${manifest.name}@${manifest.version}, ${files.length} files, ${(size / 1024).toFixed(1)} KiB unpacked`);
for (const file of files) console.log(`  ${file}`);
