'use strict';

const fs   = require('fs');
const path = require('path');
const { dryRunLog } = require('./platform.js');

const REPO_ROOT     = path.resolve(__dirname, '..');
const COMMANDS_SRC  = path.join(REPO_ROOT, '.claude', 'commands');
const SKILLS_SRC    = path.join(REPO_ROOT, '.claude', 'skills');
const RULES_SRC     = path.join(REPO_ROOT, 'rules');

/**
 * Install all capabilities (commands + skills + rules) into targetRoot/.claude/.
 * Runs Bug 1 + Bug 2 sweeps before copying.
 * @param {string} targetRoot  - e.g. os.homedir() for global install
 * @param {boolean} [dryRun]
 */
function installCapabilities(targetRoot, dryRun = false) {
  installCommands(targetRoot, dryRun);
  installSkills(targetRoot, dryRun);
  installRules(targetRoot, dryRun);
}

/**
 * Bug 1 sweep + copy claws-*.md commands into targetRoot/.claude/commands/.
 * @param {string} targetRoot
 * @param {boolean} [dryRun]
 */
function installCommands(targetRoot, dryRun = false) {
  const cmdDir = path.join(targetRoot, '.claude', 'commands');

  if (dryRun) {
    dryRunLog(`mkdir ${cmdDir}`);
  } else {
    fs.mkdirSync(cmdDir, { recursive: true });
  }

  sweepCommands(cmdDir, dryRun);

  if (!fs.existsSync(COMMANDS_SRC)) return;
  const files = fs.readdirSync(COMMANDS_SRC).filter(
    f => f === 'claws.md' || (f.startsWith('claws-') && f.endsWith('.md'))
  );
  for (const f of files) {
    const src  = path.join(COMMANDS_SRC, f);
    const dest = path.join(cmdDir, f);
    if (dryRun) { dryRunLog(`copy ${src} → ${dest}`); continue; }
    fs.copyFileSync(src, dest);
  }
}

/**
 * Bug 2 sweep + copy claws-* skill dirs into targetRoot/.claude/skills/.
 * @param {string} targetRoot
 * @param {boolean} [dryRun]
 */
function installSkills(targetRoot, dryRun = false) {
  const skillsDir = path.join(targetRoot, '.claude', 'skills');

  if (dryRun) {
    dryRunLog(`mkdir ${skillsDir}`);
  } else {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  sweepSkills(skillsDir, dryRun);

  if (!fs.existsSync(SKILLS_SRC)) return;
  const dirs = fs.readdirSync(SKILLS_SRC).filter(
    d => (d.startsWith('claws-') || d.startsWith('dev-protocol-')) &&
         fs.statSync(path.join(SKILLS_SRC, d)).isDirectory()
  );
  for (const d of dirs) {
    const src  = path.join(SKILLS_SRC, d);
    const dest = path.join(skillsDir, d);
    if (path.resolve(src) === path.resolve(dest)) continue; // self-collision guard
    if (dryRun) { dryRunLog(`copy ${src}/ → ${dest}/`); continue; }
    fs.cpSync(src, dest, { recursive: true });
  }
}

/**
 * Copy claws-default-behavior.md rule into targetRoot/.claude/rules/.
 * @param {string} targetRoot
 * @param {boolean} [dryRun]
 */
function installRules(targetRoot, dryRun = false) {
  const rulesDir = path.join(targetRoot, '.claude', 'rules');
  const ruleSrc  = path.join(RULES_SRC, 'claws-default-behavior.md');

  if (!fs.existsSync(ruleSrc)) return;

  if (dryRun) {
    dryRunLog(`mkdir ${rulesDir}`);
    dryRunLog(`copy ${ruleSrc} → ${path.join(rulesDir, 'claws-default-behavior.md')}`);
    return;
  }

  fs.mkdirSync(rulesDir, { recursive: true });
  fs.copyFileSync(ruleSrc, path.join(rulesDir, 'claws-default-behavior.md'));
}

/**
 * Bug 1: remove stale claws-*.md files from cmdDir.
 * @param {string} cmdDir
 * @param {boolean} [dryRun]
 */
function sweepCommands(cmdDir, dryRun = false) {
  if (!fs.existsSync(cmdDir)) return;
  const stale = fs.readdirSync(cmdDir).filter(
    f => f === 'claws.md' || (f.startsWith('claws-') && f.endsWith('.md'))
  );
  for (const f of stale) {
    const p = path.join(cmdDir, f);
    if (dryRun) { dryRunLog(`sweep stale command ${p}`); continue; }
    fs.rmSync(p);
  }
}

/**
 * Bug 2: remove stale claws-* skill dirs from skillsDir.
 * @param {string} skillsDir
 * @param {boolean} [dryRun]
 */
function sweepSkills(skillsDir, dryRun = false) {
  if (!fs.existsSync(skillsDir)) return;
  const stale = fs.readdirSync(skillsDir).filter(
    d => d.startsWith('claws-') &&
         fs.statSync(path.join(skillsDir, d)).isDirectory()
  );
  for (const d of stale) {
    const p = path.join(skillsDir, d);
    if (dryRun) { dryRunLog(`sweep stale skill dir ${p}`); continue; }
    fs.rmSync(p, { recursive: true });
  }
}

module.exports = {
  installCapabilities,
  installCommands,
  installSkills,
  installRules,
  sweepCommands,
  sweepSkills,
};
