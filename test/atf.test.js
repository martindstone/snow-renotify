// Runs the generated ATF step scripts (addons/tests) offline: the real Script Includes and the real Business Rule, against a fake
// record store, a minimal Jasmine and the test kit's own fake PagerDuty. If a script passes here it is syntactically sound and
// agrees with the code; the platform-only checks (wiring-install) run on an instance.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const YAML = require('yaml');
const { makeStore } = require('./support/platform');
const { TESTS } = require('../tools/atf/generate');

const ROOT = path.join(__dirname, '..');
const SI_DIR = path.join(ROOT, 'src', 'Server Development', 'Script Includes');
const KIT = path.join(ROOT, 'addons', 'tests', 'Server Development', 'Script Includes', 'PagerDutyRenotifyTestKit.js');
const STEP_DIR = path.join(ROOT, 'addons', 'tests', 'Tests', 'Test Step');
const BR_FILE = path.join(ROOT, 'src', 'Server Development', 'Business Rules', 'PD Renotify Escalation Policy on Webhook');

const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/** The part of Jasmine the step scripts use, run synchronously. Returns the specs with their outcome. */
function miniJasmine(ctx) {
  const root = { name: '', children: [], before: [], after: [] };
  let current = root;
  const specs = [];
  ctx.describe = (name, fn) => {
    const suite = { name, children: [], before: [], after: [], parent: current };
    current.children.push(suite);
    const saved = current; current = suite; fn(); current = saved;
  };
  ctx.beforeEach = (fn) => current.before.push(fn);
  ctx.afterEach = (fn) => current.after.push(fn);
  ctx.it = (name, fn) => current.children.push({ spec: true, name, fn, parent: current });

  const expectation = (actual, negate) => {
    const check = (ok, message) => { if (negate ? ok : !ok) throw new assert.AssertionError({ message: `${negate ? 'not ' : ''}${message}` }); };
    const eq = (a, b) => { try { assert.deepStrictEqual(plain(a), plain(b)); return true; } catch (e) { return false; } };
    const show = (x) => JSON.stringify(plain(x));
    return {
      toBe: (e) => check(actual === e, `expected ${show(actual)} to be ${show(e)}`),
      toEqual: (e) => check(eq(actual, e), `expected ${show(actual)} to equal ${show(e)}`),
      toBeTruthy: () => check(!!actual, `expected ${show(actual)} to be truthy`),
      toBeFalsy: () => check(!actual, `expected ${show(actual)} to be falsy`),
      toContain: (e) => check(actual.indexOf(e) >= 0, `expected ${show(actual)} to contain ${show(e)}`)
    };
  };
  ctx.expect = (actual) => Object.assign(expectation(actual, false), { not: expectation(actual, true) });

  const walk = (node, path) => {
    node.children.forEach((child) => {
      if (!child.spec) { walk(child, path.concat(child.name)); return; }
      const chain = []; for (let n = child.parent; n; n = n.parent) chain.unshift(n);
      let error = null;
      try {
        chain.forEach((n) => n.before.forEach((f) => f()));
        child.fn();
      } catch (e) { error = e; }
      try { chain.slice().reverse().forEach((n) => n.after.forEach((f) => f())); } catch (e) { error = error || e; }
      specs.push({ title: path.concat(child.name).join(' > '), error });
    });
  };
  ctx.jasmine = { getEnv: () => ({ execute: () => walk(root, []) }) };
  return specs;
}

function makeContext() {
  const brSource = fs.readFileSync(BR_FILE + '.js', 'utf8');
  const brCondition = YAML.parse(fs.readFileSync(BR_FILE + '.yaml', 'utf8')).payload.record_update.sys_script.condition;
  const events = [];
  let ctx;
  const store = makeStore({
    afterInsert: (gr) => {
      if (gr.table !== 'x_pd_integration_webhook_import') return;
      // what the platform does for an "after insert" Business Rule with a condition
      const current = new Proxy(gr, { get: (t, k) => (k in t ? t[k] : t.row[k]) });
      if (vm.runInContext(`(function (current) { return ${brCondition}; })`, ctx)(current)) {
        vm.runInContext(brSource, Object.assign(ctx, { current, previous: null }));
      }
    }
  });
  ctx = {
    Class: { create() { return function () { if (this.initialize) this.initialize.apply(this, arguments); }; } },
    gs: { nil: (x) => x === undefined || x === null || x === '', getProperty: () => undefined, debug() {}, info() {}, warn() {}, error() {}, eventQueue: (name, gr, p1) => events.push({ name, id: p1 }) },
    GlideRecord: function (t) { return new store.GR(t); },
    GlideRecordSecure: function (t) { return new store.GR(t); },
    JSON, Date, Error, isNaN, String, Object, Array, Math, encodeURIComponent,
    x_pd_integration: {}
  };
  vm.createContext(ctx);
  const load = (file, name) => {
    vm.runInContext(fs.readFileSync(file, 'utf8') + `\nthis.${name} = ${name};`, ctx);
    ctx.x_pd_integration[name] = ctx[name];
  };
  ['PagerDutyRenotifyMachine', 'PagerDutyRenotify'].forEach((n) => load(path.join(SI_DIR, n + '.js'), n));
  load(KIT, 'PagerDutyRenotifyTestKit');
  return { ctx, events, store };
}

const stepScript = (test) => {
  const stepYaml = fs.readdirSync(STEP_DIR).filter((f) => f.endsWith('.yaml'))
    .find((f) => YAML.parse(fs.readFileSync(path.join(STEP_DIR, f), 'utf8')).payload.record_update.sys_atf_step.test.$.display_value === test.name);
  assert.ok(stepYaml, `no generated step for ${test.name}: run node tools/atf/generate.js`);
  return fs.readFileSync(path.join(STEP_DIR, stepYaml.replace(/\.yaml$/, '.js')), 'utf8');
};

describe('ATF step scripts (addons/tests), run offline', () => {
  TESTS.filter((t) => t.offline !== false).forEach((test) => {
    describe(test.name, () => {
      const { ctx, store } = makeContext();
      const specs = miniJasmine(ctx);
      let loadError = null;
      try {
        vm.runInContext(stepScript(test), Object.assign(ctx, { outputs: {}, steps: {}, params: {}, stepResult: {}, assertEqual() {} }));
      } catch (e) { loadError = e; }
      if (loadError) it('loads', () => { throw loadError; });
      else if (!specs.length) it('has specs', () => assert.fail('the script ran no specs'));
      specs.forEach((spec) => it(spec.title, () => { if (spec.error) throw spec.error; }));
      it('leaves no run rows behind', () => {
        assert.strictEqual((store.tables.x_pd_integration_renotify_run || []).length, 0);
        assert.strictEqual((store.tables.x_pd_integration_webhook_import || []).length, 0);
      });
    });
  });

  it('every test in the manifest has a step script, and every script is in the manifest', () => {
    const scripts = fs.readdirSync(path.join(ROOT, 'tools', 'atf', 'steps')).map((f) => f.replace(/\.js$/, '')).sort();
    assert.deepStrictEqual(TESTS.map((t) => t.file).sort(), scripts);
  });
});
