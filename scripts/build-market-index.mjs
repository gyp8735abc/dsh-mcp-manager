#!/usr/bin/env node
// Build the plugin market index (format 1) that the Web "Plugins → Discover" tab reads.
//
// Usage:
//   node scripts/build-market-index.mjs                 # version + timestamp from package.json / now
//   node scripts/build-market-index.mjs --from-registry # read the real publish time from npm
//   node scripts/build-market-index.mjs --version 0.2.1 --timestamp 1793000000
//   node scripts/build-market-index.mjs --validator "D:/p/npm-global/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js"
//
// The index is written to docs/index.json so GitHub Pages ("Deploy from a branch", /docs)
// serves it at https://<user>.github.io/<repo>/index.json, and the icon is copied next to
// it because a relative icon reference resolves against the index URL.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const version = flag("version", manifest.version);
const output = resolve(root, flag("output", join("docs", "index.json")));
const registry = flag("registry", "https://registry.npmjs.org");

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`build-market-index: "${version}" is not an exact SemVer version`);
  process.exit(1);
}

/** Unix seconds for this version: the real publish time when asked, otherwise now. */
async function publishTimestamp() {
  const explicit = flag("timestamp");
  if (explicit !== undefined) return Number(explicit);
  if (!has("from-registry")) return Math.floor(Date.now() / 1000);
  const url = `${registry}/${manifest.name.replace("/", "%2f")}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const document = await response.json();
  const published = document?.time?.[version];
  if (published === undefined) throw new Error(`${manifest.name}@${version} is not published yet`);
  return Math.floor(new Date(published).getTime() / 1000);
}

const engines = {};
if (manifest.engines?.dsh !== undefined) engines.dsh = manifest.engines.dsh;

const index = {
  format: 1,
  title: {
    en: "DeepSeek Harness plugins by gyp8735abc",
    zh: "gyp8735abc 的 DeepSeek Harness 插件",
  },
  description: {
    en: "Bundles published from github.com/gyp8735abc",
    zh: "由 github.com/gyp8735abc 发布的插件",
  },
  metadata: {
    categories: {
      mcp: { title: { en: "MCP", zh: "MCP" } },
      skills: { title: { en: "Skills", zh: "技能" } },
      workspace: { title: { en: "Workspaces", zh: "工作区" } },
    },
    labels: {
      "per-workspace": { title: { en: "Per workspace", zh: "按工作区" } },
    },
  },
  plugins: [
    {
      name: manifest.name,
      title: {
        en: "MCP manager (per workspace)",
        zh: "MCP 管理器（按工作区）",
      },
      description: {
        en: "Enable or disable global MCP, project MCP and skills separately for each workspace, from one popup on the workspace row",
        zh: "在每个工作区行用一个弹窗，按工作区独立启用/停用全局 MCP、项目 MCP 与技能",
      },
      icon: "./icon.svg",
      author: typeof manifest.author === "string" ? manifest.author : manifest.author?.name,
      homepage: manifest.homepage,
      repository: { url: manifest.repository.url.replace(/^git\+/, "").replace(/\.git$/, "") },
      metadata: {
        category: "mcp",
        keywords: manifest.keywords ?? [],
        labels: ["per-workspace"],
      },
      versions: [
        {
          version,
          publishTimestamp: await publishTimestamp(),
          source: { type: "npm" },
          ...(Object.keys(engines).length > 0 ? { engines } : {}),
        },
      ],
    },
  ],
};

// Keep the icon next to the index: a relative reference resolves against the index URL.
mkdirSync(dirname(output), { recursive: true });
copyFileSync(join(root, "icon.svg"), join(dirname(output), "icon.svg"));
writeFileSync(output, `${JSON.stringify(index, null, 2)}\n`, "utf8");
console.log(`build-market-index: wrote ${output} (${manifest.name}@${version})`);

// Validate with the real reader when it is reachable, so a broken index never ships.
const validator = flag("validator");
const candidates = [
  validator,
  join(root, "node_modules", "@deepseek-ai", "dsh-plugin-market-index", "lib", "index.js"),
].filter((candidate) => candidate !== undefined);
for (const candidate of candidates) {
  try {
    const module = await import(pathToFileURL(candidate).href);
    module.parseMarketIndex(index, "https://example.github.io/x/index.json");
    console.log(`build-market-index: validated by ${candidate}`);
    process.exit(0);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ENOENT") continue;
    console.error(`build-market-index: index rejected: ${String(error)}`);
    process.exit(1);
  }
}
console.warn("build-market-index: official validator not found; skipped format validation (pass --validator <path>)");
