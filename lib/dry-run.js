'use strict';

const fs = require('fs');
const { dryRunLog } = require('./platform.js');

function mkdir(dir, dryRun) {
  if (dryRun) { dryRunLog(`mkdir ${dir}`); return; }
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest, dryRun) {
  if (dryRun) { dryRunLog(`copy ${src} → ${dest}`); return; }
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest, dryRun) {
  if (dryRun) { dryRunLog(`copy ${src}/ → ${dest}/`); return; }
  fs.cpSync(src, dest, { recursive: true });
}

function writeFile(filePath, content, dryRun) {
  if (dryRun) { dryRunLog(`write ${filePath}`); return; }
  const tmp = filePath + '.claws-tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function removeFile(filePath, dryRun) {
  if (dryRun) { dryRunLog(`rm ${filePath}`); return; }
  fs.rmSync(filePath);
}

function removeDir(dirPath, dryRun) {
  if (dryRun) { dryRunLog(`rm -rf ${dirPath}`); return; }
  fs.rmSync(dirPath, { recursive: true });
}

function spawn(label, fn, dryRun) {
  if (dryRun) { dryRunLog(label); return; }
  fn();
}

module.exports = { mkdir, copyFile, copyDir, writeFile, removeFile, removeDir, spawn };
