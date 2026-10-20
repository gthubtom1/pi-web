#!/usr/bin/env node
/**
 * Build this app, pack the prebuilt artifact, and (optionally) publish it.
 *
 * Why a tarball at all: the repository is source, so installing it the developer way
 * (`git clone && npm install && npm run deploy`) runs a Next build — minutes of CPU and a
 * large heap. The upstream project feels like "one command, two minutes" because its npm
 * package already contains `.next`. This script produces the same thing: a tarball with
 * the built app, which installs in seconds and needs no build on the user's machine.
 *
 * Usage:
 *   npm run release:tarball                 # build + pack, print the publish command
 *   npm run release:tarball -- --skip-build # pack what is already built
 *   npm run release:tarball -- --publish    # build + pack + create/refresh the GitHub release
 *
 * The tarball is gitignored: it belongs on a GitHub Release, not in the repository.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const publish = args.has("--publish");

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const fork = JSON.parse(readFileSync(join(repoRoot, "fork.json"), "utf8"));
const tarballName = `${pkg.name}-${pkg.version}.tgz`;
const tarballPath = join(repoRoot, tarballName);
const tag = `v${pkg.version}`;
const releaseUrl = `${fork.repository}/releases/tag/${tag}`;
const installCommand = `npm install -g --allow-scripts=pi-web-fork,node-pty,@google/genai,protobufjs ${fork.repository}/releases/download/${tag}/${tarballName}`;

function run(commandLine) {
  console.log(`[release] ${commandLine}`);
  execFileSync(commandLine, { cwd: repoRoot, stdio: "inherit", shell: true, timeout: 1_800_000 });
}

if (!skipBuild) {
  // The build script picks its own heap (PI_WEB_BUILD_HEAP_MB); this wrapper just runs it.
  run("npm run build");
} else if (!existsSync(join(repoRoot, ".next", "BUILD_ID"))) {
  console.error("[release] --skip-build was given but .next/BUILD_ID is missing: build first.");
  process.exit(1);
}

// `npm pack` honours package.json's `files` list, so the artifact is exactly what the app
// needs at runtime (no sources, no .nft.json tracing data, no webpack cache).
run("npm pack --silent");

const size = statSync(tarballPath).size;
console.log(`\n[release] ${tarballName}  ${(size / 1048576).toFixed(1)} MB`);
console.log(`[release] one-command install (prebuilt, no build step):`);
console.log(`  ${installCommand}`);

if (!publish) {
  console.log("");
  console.log("[release] publish it with:");
  console.log(`  gh release create ${tag} "${tarballPath}" --title "${pkg.name} ${tag}" --notes "Prebuilt package. Install: ${installCommand}"`);
  process.exit(0);
}

const exists = spawnSync("gh", ["release", "view", tag], { cwd: repoRoot, stdio: "ignore" }).status === 0;
if (exists) {
  run(`gh release upload ${tag} "${tarballPath}" --clobber`);
} else {
  run(`gh release create ${tag} "${tarballPath}" --title "${pkg.name} ${tag}" --notes "Prebuilt package. Install: ${installCommand}"`);
}
console.log(`\n[release] published: ${releaseUrl}`);
