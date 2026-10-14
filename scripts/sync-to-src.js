// Copies lib/renotify.js into src/ as the PagerDutyRenotifyMachine Script Include (lib/ is the tested source of truth).
// Usage: node scripts/sync-to-src.js
const fs = require('fs');
const path = require('path');
const target = path.join(__dirname, '..', 'src', 'Server Development', 'Script Includes', 'PagerDutyRenotifyMachine.js');
let src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'renotify.js'), 'utf8');
src = src
  .replace('var Renotify = (function () {', "var PagerDutyRenotifyMachine = Class.create();\nPagerDutyRenotifyMachine.prototype = (function () {")
  .replace(/\n\nif \(typeof module !== 'undefined'\) module\.exports = Renotify;\n$/, '\n');
if (!src.includes('PagerDutyRenotifyMachine.prototype') || src.includes('module.exports')) throw new Error('sync transform failed');
fs.writeFileSync(target, src);
console.log('wrote', target);
