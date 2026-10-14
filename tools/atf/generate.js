#!/usr/bin/env node
// Generates the records of the optional tests package (addons/tests) from tools/atf/steps/*.js and the manifest below.
//   node tools/atf/generate.js
//
// Each manifest entry becomes an ATF test with one "Run Server Side Script" step whose script is the file's content, wrapped the
// way the integration app's own ATF tests are (a Jasmine 3.1 script). The test kit Script Include is written by hand, only its
// record is generated here. Ids are derived from names, so regenerating changes nothing unless the manifest does.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'addons', 'tests');
const STEPS = path.join(__dirname, 'steps');

const APP = { id: '39a9d9664f834e00dd657bb28110c77b', name: 'PagerDuty Incident Resolution Platform', scope: 'x_pd_integration' };
const STAMP = '2026-10-09 12:00:00';
const BY = 'PagerDuty';
const RUN_SCRIPT_STEP_CONFIG = '41de4a935332120028bc29cac2dc349a';
const SCRIPT_VARIABLE = { id: '989d9e235324220002c6435723dc3484', label: 'Test script' };
const JASMINE_VARIABLE = { id: '42f2564b73031300440211d8faf6a777', label: 'Jasmine version' };

const SUITE = {
  name: 'PD: Renotify',
  description: 'Tests of the Renotify Escalation Policy overlay. They run the real Script Includes against a fake PagerDuty and a fake clock, '
    + 'so no PagerDuty account, WireMock or waiting is needed. The only records they create are runs and webhook rows of their own, which they remove again. '
    + 'The overlay itself ("PagerDuty Renotify v…") must be installed first.'
};

// order matters: it is the order of the suite
const TESTS = [
  { file: 'wiring-install', offline: false, name: 'PD: Renotify install - the overlay\'s records are in place', about: 'The run table and its columns, the Script Includes, the Business Rule, the event, Script Action and tick, the button and the dialog.' },
  { file: 'machine-levels', name: 'PD: Renotify machine - levels, joins and declines', about: 'The decision logic only (no records): which level is asked when, and what a join, a decline or a stale reply does.' },
  { file: 'machine-timeouts', name: 'PD: Renotify machine - timeouts, loops and the end', about: 'The decision logic only: level delays, the policy\'s loops, exhaustion, shift changes, and when a level counts as due.' },
  { file: 'machine-already-asked', name: 'PD: Renotify machine - people PagerDuty already asked', about: 'The decision logic only: answers from people PagerDuty asked itself count from PagerDuty\'s own request time.' },
  { file: 'run-start', name: 'PD: Renotify run - start', about: 'Starting a run: level 1 only, the saved run, the checks before anything is sent, and the person clicking asked on behalf of another user.' },
  { file: 'run-replies', name: 'PD: Renotify run - replies, timeouts and the end', about: 'A run in the real table: declines, duplicate deliveries, joins, the level delay, loops, exhaustion, resolution and recovery.' },
  { file: 'run-already-asked', name: 'PD: Renotify run - people PagerDuty already asked', about: 'Not asking again someone PagerDuty has just asked, while still waiting for their answer.' },
  { file: 'run-failures-and-stop', name: 'PD: Renotify run - failures, stopping and single people', about: 'PagerDuty failures, Stop, and renotifying one person.' },
  { file: 'wiring-webhook', name: 'PD: Renotify webhook - the Business Rule feeds the run', about: 'Inserts webhook rows like the inbound handling does and checks the run follows: join and resolution end it, anything else leaves it alone.' }
];

const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');
const id = (kind, name) => md5(`pd-ep-renotify-tests:${kind}:${name}`);
const slug = (text) => text.replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/ /g, '_');
const ref = { $: { display_value: APP.name }, _: APP.id };
const pkg = { $: { display_value: APP.name, source: APP.scope }, _: APP.id };

const writeYaml = (file, doc) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(doc, { lineWidth: 0 }));
};

/** The record fields every update has in common. */
function wrap({ table, type, name, targetName, node, sysId, extra }) {
  return {
    $: { action: 'INSERT_OR_UPDATE' },
    action: 'INSERT_OR_UPDATE',
    application: ref,
    category: 'customer',
    comments: '',
    name,
    payload: { record_update: Object.assign({ $: { table }, [table]: node }, extra || {}) },
    replace_on_upgrade: 'false',
    sys_mod_count: '0',
    table: '',
    target_name: targetName,
    type,
    update_domain: 'global',
    update_guid: md5(`guid:${name}`),
    update_guid_history: `${md5(`guid:${name}`)}:0`,
    update_set: { $: { display_value: '' } },
    view: ''
  };
}

/** The fields the platform stamps on every record. */
function stamped(table, sysId, sysName) {
  return {
    sys_class_name: table,
    sys_created_by: BY,
    sys_created_on: STAMP,
    sys_id: sysId,
    sys_mod_count: '0',
    sys_name: sysName,
    sys_package: pkg,
    sys_policy: '',
    sys_scope: ref,
    sys_update_name: `${table}_${sysId}`,
    sys_updated_by: BY,
    sys_updated_on: STAMP
  };
}

function titlesOf(script) {
  const titles = [];
  script.replace(/^\s*it\('((?:[^'\\]|\\.)*)'/gm, (m, t) => { titles.push(t.replace(/\\'/g, '\'')); return m; });
  return titles;
}

function generate() {
  fs.rmSync(path.join(OUT, 'Tests'), { recursive: true, force: true });
  const testIds = [];

  TESTS.forEach((t) => {
    const scriptFile = path.join(STEPS, `${t.file}.js`);
    if (!fs.existsSync(scriptFile)) throw new Error(`missing step script: ${scriptFile}`);
    const body = fs.readFileSync(scriptFile, 'utf8').replace(/\s+$/, '');
    const titles = titlesOf(body);
    if (!titles.length) throw new Error(`${t.file}.js has no tests (it('...'))`);

    const testId = id('test', t.name);
    const stepId = id('step', t.name);
    testIds.push({ id: testId, name: t.name });

    const description = `${t.about}\r\n\r\nChecks that:\r\n${titles.map((x) => `- ${x}`).join('\r\n')}`;
    writeYaml(path.join(OUT, 'Tests', 'Test', `${t.name.replace(/[:/]/g, '-')}.yaml`), wrap({
      table: 'sys_atf_test', type: 'Test', name: `sys_atf_test_${testId}`, targetName: t.name,
      node: Object.assign({
        $: { action: 'INSERT_OR_UPDATE' },
        active: 'true',
        copied_from: '',
        description,
        enable_parameterized_testing: 'false',
        fail_on_server_error: 'true',
        name: t.name,
        parameters: '',
        remember: '',
        sn_atf_tg_generated: 'false'
      }, stamped('sys_atf_test', testId, t.name)),
      extra: { sys_variable_value: { $: { action: 'delete_multiple', query: `document_key=${testId}` } } }
    }));

    // The script file sits next to the step's yaml and is referenced from it.
    const stepBase = `Run Server Side Script - ${stepId}`;
    const stepDir = path.join(OUT, 'Tests', 'Test Step');
    fs.mkdirSync(stepDir, { recursive: true });
    fs.writeFileSync(path.join(stepDir, `${stepBase}.js`),
      `(function(outputs, steps, params, stepResult, assertEqual) {\n${body.replace(/^/gm, '    ').replace(/^ +$/gm, '')}\n})(outputs, steps, params, stepResult, assertEqual);\n\njasmine.getEnv().execute();\n`);
    const variable = (variableDef, order, key, value) => Object.assign({
      $: { action: 'INSERT_OR_UPDATE' },
      document: 'sys_atf_step',
      document_key: stepId,
      order: String(order),
      sys_class_name: 'sys_variable_value',
      sys_created_by: BY,
      sys_created_on: STAMP,
      sys_id: id('variable', `${t.name}:${key}`),
      sys_mod_count: '0',
      sys_updated_by: BY,
      sys_updated_on: STAMP,
      value,
      variable: { $: { display_value: variableDef.label }, _: variableDef.id }
    });
    writeYaml(path.join(stepDir, `${stepBase}.yaml`), wrap({
      table: 'sys_atf_step', type: 'Test Step', name: `sys_atf_step_${stepId}`, targetName: 'Run Server Side Script',
      node: Object.assign({
        $: { action: 'INSERT_OR_UPDATE' },
        active: 'true',
        callable_outputs: '',
        copied_from: '',
        description: 'Run Server Side Validation Script',
        display_name: 'Run Server Side Script',
        inputs: '',
        mugshots_cache_json: '',
        notes: '',
        order: '1',
        step_config: { $: { display_value: 'Run Server Side Script' }, _: RUN_SCRIPT_STEP_CONFIG },
        table: '',
        test: { $: { display_value: t.name }, _: testId },
        timeout: '',
        warning_message: ''
      }, stamped('sys_atf_step', stepId, 'Run Server Side Script')),
      extra: {
        sys_variable_value: [
          { $: { action: 'delete_multiple', query: `document_key=${stepId}` } },
          variable(SCRIPT_VARIABLE, 200, 'script', { $ref: `${stepBase}.js` }),
          variable(JASMINE_VARIABLE, 100, 'jasmine', '3.1')
        ]
      }
    }));
  });

  const suiteId = id('suite', SUITE.name);
  writeYaml(path.join(OUT, 'Tests', 'Test Suite', `${SUITE.name.replace(/[:/]/g, '-')}.yaml`), wrap({
    table: 'sys_atf_test_suite', type: 'Test Suite', name: `sys_atf_test_suite_${suiteId}`, targetName: SUITE.name,
    node: Object.assign({
      $: { action: 'INSERT_OR_UPDATE' },
      active: 'true',
      description: SUITE.description,
      name: SUITE.name,
      parent: ''
    }, stamped('sys_atf_test_suite', suiteId, SUITE.name))
  }));

  testIds.forEach((t, index) => {
    const linkId = id('suite-test', `${SUITE.name}:${t.name}`);
    writeYaml(path.join(OUT, 'Tests', 'Test Suite Test', `${slug(SUITE.name)}-${String(index + 1).padStart(2, '0')}-${linkId}.yaml`), wrap({
      table: 'sys_atf_test_suite_test', type: 'Test Suite Test', name: `sys_atf_test_suite_test_${linkId}`, targetName: suiteId,
      node: Object.assign({
        $: { action: 'INSERT_OR_UPDATE' },
        abort_on_failure: 'false',
        order: String((index + 1) * 100),
        test: { $: { display_value: t.name }, _: t.id },
        test_suite: { $: { display_value: SUITE.name }, _: suiteId }
      }, stamped('sys_atf_test_suite_test', linkId, suiteId))
    }));
  });

  // the test kit's own record (its script is written by hand)
  const kitName = 'PagerDutyRenotifyTestKit';
  const kitId = id('script-include', kitName);
  writeYaml(path.join(OUT, 'Server Development', 'Script Includes', `${kitName}.yaml`), wrap({
    table: 'sys_script_include', type: 'Script Include', name: `sys_script_include_${kitId}`, targetName: kitName,
    node: Object.assign({
      $: { action: 'INSERT_OR_UPDATE' },
      access: 'package_private',
      active: 'true',
      api_name: `${APP.scope}.${kitName}`,
      caller_access: '',
      client_callable: 'false',
      description: 'Helpers for the PD: Renotify ATF tests (optional tests package of the Renotify overlay)',
      mobile_callable: 'false',
      name: kitName,
      sandbox_callable: 'false',
      script: { $ref: `${kitName}.js` }
    }, stamped('sys_script_include', kitId, kitName))
  }));

  // the package itself
  const defaults = path.join(OUT, 'defaults.yaml');
  if (!fs.existsSync(defaults)) {
    fs.writeFileSync(defaults, `createdBy: PagerDuty_Renotify_v1.0.0\nupdatedBy: PagerDuty_Renotify_v1.0.0\nversionPrefix: "PagerDuty Renotify Tests v"\nversion: 1.0.0\n`);
  }
  const updateSet = path.join(OUT, 'sys_remote_update_set.yaml');
  if (!fs.existsSync(updateSet)) {
    const base = YAML.parse(fs.readFileSync(path.join(ROOT, 'src', 'sys_remote_update_set.yaml'), 'utf8'));
    base.name = "PagerDuty Renotify Tests v1.0.0";
    base.description = 'ATF tests for the Renotify Escalation Policy overlay (optional; install the overlay first)';
    base.remote_sys_id = id('remote-update-set', 'tests');
    base.sys_id = id('update-set', 'tests');
    fs.writeFileSync(updateSet, YAML.stringify(base, { lineWidth: 0 }));
  }
  console.log(`generated ${TESTS.length} tests, 1 suite, ${TESTS.length} suite links and the test kit into ${path.relative(ROOT, OUT)}`);
}

if (require.main === module) generate();
module.exports = { TESTS, SUITE, OUT };
