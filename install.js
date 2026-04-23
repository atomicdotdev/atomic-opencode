#!/usr/bin/env node

/**
 * atomic-opencode install
 *
 * Symlinks the agent prompt and skills from this package into
 * ~/.config/opencode/ so OpenCode discovers them automatically.
 *
 * Usage:
 *   npx atomic-opencode          # install from npm
 *   node install.js              # install from local checkout
 *   node install.js --silent     # postinstall (no output on success)
 *   node install.js --uninstall  # remove symlinks
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const silent = process.argv.includes("--silent");
const uninstall = process.argv.includes("--uninstall");

const PKG_DIR = __dirname;
const TARGET = path.join(os.homedir(), ".config", "opencode");

const LINKS = [
  { src: "agents/atomic.md", dst: "agents/atomic.md" },
  {
    src: "skills/atomic-vault/SKILL.md",
    dst: "skills/atomic-vault/SKILL.md",
  },
  {
    src: "skills/code-intelligence/SKILL.md",
    dst: "skills/code-intelligence/SKILL.md",
  },
  { src: "opencode.json", dst: "opencode.json" },
];

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isOurSymlink(dstPath) {
  try {
    if (!fs.lstatSync(dstPath).isSymbolicLink()) return false;
    const target = fs.readlinkSync(dstPath);
    return target.startsWith(PKG_DIR);
  } catch {
    return false;
  }
}

function doInstall() {
  let installed = 0;
  let skipped = 0;

  for (const { src, dst } of LINKS) {
    const srcPath = path.join(PKG_DIR, src);
    const dstPath = path.join(TARGET, dst);

    if (!fs.existsSync(srcPath)) {
      if (!silent) console.warn(`  skip: ${src} (not found in package)`);
      continue;
    }

    // Don't overwrite user's own files (only replace our symlinks)
    if (fs.existsSync(dstPath) && !isOurSymlink(dstPath)) {
      skipped++;
      if (!silent) console.log(`  keep: ${dst} (user file, not overwriting)`);
      continue;
    }

    // Remove existing symlink if present
    if (fs.existsSync(dstPath) || isOurSymlink(dstPath)) {
      fs.unlinkSync(dstPath);
    }

    ensureDir(dstPath);
    fs.symlinkSync(srcPath, dstPath);
    installed++;
    if (!silent) console.log(`  link: ${dst}`);
  }

  if (!silent) {
    console.log();
    console.log(
      `✓ atomic-opencode installed (${installed} linked, ${skipped} skipped)`
    );
    console.log(`  Target: ${TARGET}`);
    console.log();
    console.log("Add this to your OpenCode config (opencode.json):");
    console.log();
    console.log('  { "plugin": ["atomic-opencode"] }');
    console.log();
  }
}

function doUninstall() {
  let removed = 0;

  for (const { dst } of LINKS) {
    const dstPath = path.join(TARGET, dst);

    if (isOurSymlink(dstPath)) {
      fs.unlinkSync(dstPath);
      removed++;
      if (!silent) console.log(`  unlink: ${dst}`);

      // Clean up empty parent dirs
      const dir = path.dirname(dstPath);
      try {
        fs.rmdirSync(dir);
      } catch {
        /* not empty, fine */
      }
    }
  }

  if (!silent) {
    console.log();
    console.log(`✓ atomic-opencode uninstalled (${removed} removed)`);
  }
}

if (uninstall) {
  doUninstall();
} else {
  doInstall();
}
