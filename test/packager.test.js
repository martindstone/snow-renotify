const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const xml2js = require('xml2js');
const P = require('../lib/packager');

const ROOT = path.join(__dirname, '..');
const APP = '39a9d9664f834e00dd657bb28110c77b';
const SET_ID = 'a'.repeat(32);

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  const all = Object.assign({
    'defaults.yaml': 'createdBy: Tester\nupdatedBy: Tester\nversionPrefix: test-v\nversion: 1.2.3\n',
    'sys_remote_update_set.yaml': `application:\n  _: ${APP}\n  $:\n    display_value: App\napplication_scope: x_scope\nremote_sys_id: ${'b'.repeat(32)}\nsys_id: ${SET_ID}\nname: x\n`
  }, files);
  Object.keys(all).forEach((f) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), all[f]);
  });
  return dir;
}
const record = (name, extra = '') => `name: ${name}\ntype: Script Include\ntarget_name: ${name}\napplication:\n  _: ${APP}\npayload:\n  record_update:\n    sys_script_include:\n      name: ${name}\n      sys_created_by: someone-else\n      script:\n        $ref: ${name}.js\n${extra}`;
const withRecords = (...names) => fixture(names.reduce((acc, n) => Object.assign(acc, { [`${n}.yaml`]: record(n), [`${n}.js`]: `// ${n} & <tags>\n` }), {}));
const problemsOf = (fn) => { try { fn(); } catch (e) { return e.problems || [e.message]; } return []; };

describe('packager: loading and validation', () => {
  it('inlines $ref files, including a .js -> .es12.js fallback', () => {
    const dir = withRecords('A');
    fs.renameSync(path.join(dir, 'A.js'), path.join(dir, 'A.es12.js'));
    const { records } = P.load(dir);
    assert.ok(records[0].payload.record_update.sys_script_include.script.startsWith('// A & <tags>'));
  });

  it('reports every problem at once, and fails', () => {
    const dir = fixture({
      'A.yaml': record('A'), // A.js missing
      'B.yaml': 'name: B\ntype: Script Include\n', // no target_name, payload
      'C.yaml': ':\n  - bad: [yaml'
    });
    const problems = problemsOf(() => P.load(dir)).join('\n');
    assert.match(problems, /A\.yaml: \$ref "A\.js" not found/);
    assert.match(problems, /B\.yaml: "target_name" is missing/);
    assert.match(problems, /B\.yaml: "payload" is missing/);
    assert.match(problems, /C\.yaml: cannot parse yaml/);
  });

  it('rejects two files using the same update name', () => {
    const dir = withRecords('A');
    fs.writeFileSync(path.join(dir, 'A2.yaml'), record('A'));
    assert.match(problemsOf(() => P.load(dir)).join('\n'), /update name "A" is already used by A\.yaml/);
  });

  it('rejects a record from another application scope', () => {
    const dir = withRecords('A');
    fs.writeFileSync(path.join(dir, 'A.yaml'), record('A').replace(APP, 'c'.repeat(32)));
    assert.match(problemsOf(() => P.load(dir)).join('\n'), /differs from the update set's/);
  });

  it('requires defaults.yaml and sys_remote_update_set.yaml with valid ids', () => {
    const dir = withRecords('A');
    fs.writeFileSync(path.join(dir, 'defaults.yaml'), 'createdBy: x\n');
    fs.writeFileSync(path.join(dir, 'sys_remote_update_set.yaml'), 'application_scope: s\nsys_id: nope\n');
    const problems = problemsOf(() => P.load(dir)).join('\n');
    assert.match(problems, /defaults\.yaml: "version" is missing/);
    assert.match(problems, /sys_id must be 32 hex/);
    assert.match(problems, /remote_sys_id must be 32 hex/);
  });

  it('fails on a missing directory and on an empty one', () => {
    assert.match(problemsOf(() => P.load('/nonexistent-dir'))[0], /source directory not found/);
    assert.match(problemsOf(() => P.load(fixture({}))).join('\n'), /no records found/);
  });

  it('rejects a record whose type label is not what exports of its table use (the "Table Column" mistake)', () => {
    const dir = fixture({
      'D.yaml': 'name: sys_dictionary_x_t_a\ntype: Table Column\ntarget_name: T.A\napplication:\n  _: ' + APP + '\npayload:\n  record_update:\n    sys_dictionary:\n      element: a\n'
    });
    assert.match(problemsOf(() => P.load(dir)).join('\n'), /type "Table Column" is not what exports of sys_dictionary records use \("Dictionary"\)/);
    fs.writeFileSync(path.join(dir, 'D.yaml'), fs.readFileSync(path.join(dir, 'D.yaml'), 'utf8').replace('Table Column', 'Dictionary'));
    assert.deepStrictEqual(problemsOf(() => P.load(dir)), []);
  });

  it('does not judge tables it has never seen', () => {
    const dir = fixture({ 'N.yaml': 'name: n1\ntype: Whatever\ntarget_name: N\napplication:\n  _: ' + APP + '\npayload:\n  record_update:\n    some_new_table:\n      a: b\n' });
    assert.deepStrictEqual(problemsOf(() => P.load(dir)), []);
  });

  it('requires a dictionary record to be named the way the platform names it (null for the table itself)', () => {
    const dict = (name, element) => `name: ${name}\ntype: Dictionary\ntarget_name: T\napplication:\n  _: ${APP}\npayload:\n  record_update:\n    sys_dictionary:\n      $:\n        element: "${element}"\n        table: x_t\n      name: x_t\n`;
    const bad = fixture({ 'a.yaml': dict('sys_dictionary_x_t_', ''), 'b.yaml': dict('sys_dictionary_x_t_other', 'col') });
    const problems = problemsOf(() => P.load(bad)).join('\n');
    assert.match(problems, /a\.yaml: update name "sys_dictionary_x_t_" should be "sys_dictionary_x_t_null"/);
    assert.match(problems, /b\.yaml: update name "sys_dictionary_x_t_other" should be "sys_dictionary_x_t_col"/);
    const good = fixture({ 'a.yaml': dict('sys_dictionary_x_t_null', ''), 'b.yaml': dict('sys_dictionary_x_t_col', 'col') });
    assert.deepStrictEqual(problemsOf(() => P.load(fixture({ 'a.yaml': dict('sys_dictionary_x_t_NULL', '') }))), [], 'import set tables use _NULL');
    assert.deepStrictEqual(problemsOf(() => P.load(good)), []);
  });

  it('applies exclude rules', () => {
    const dir = withRecords('Keep', 'MockUtil');
    const { records } = P.load(dir, { exclude: [{ type: 'Script Include', targetNameIncludes: 'Mock' }] });
    assert.deepStrictEqual(records.map((r) => r.name), ['Keep']);
  });
});

describe('packager: output', () => {
  const now = new Date('2026-10-08T17:03:12Z');
  const build = (dir, opts) => P.build(P.load(dir), Object.assign({ now }, opts));

  it('derives record ids from the update set and record name: stable, unique, and not shared with another update set', () => {
    const a = build(withRecords('A', 'B', 'C')).items.map((i) => i.sys_id);
    const again = build(withRecords('C', 'B', 'A')).items.map((i) => i.sys_id).sort();
    assert.deepStrictEqual(a.slice().sort(), again);
    assert.strictEqual(new Set(a).size, 3);
    assert.ok(a.every((id) => /^[a-f0-9]{32}$/.test(id)));
    assert.ok(!a.includes('0'.repeat(32)), 'must not use the app packager\'s index-based ids');
    // same record name, different update set -> different id
    const other = withRecords('A');
    fs.writeFileSync(path.join(other, 'sys_remote_update_set.yaml'), fs.readFileSync(path.join(other, 'sys_remote_update_set.yaml'), 'utf8').replace(SET_ID, 'd'.repeat(32)));
    assert.notStrictEqual(build(other).items[0].sys_id, build(withRecords('A')).items[0].sys_id);
  });

  it('stamps UTC regardless of the machine time zone', () => {
    const script = `const P=require(${JSON.stringify(path.join(ROOT, 'lib', 'packager'))});console.log(P.utcStamp(new Date('2026-06-17T17:54:28Z')))`;
    ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo'].forEach((tz) => {
      const r = spawnSync(process.execPath, ['-e', script], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
      assert.strictEqual(r.stdout.trim(), '2026-06-17 17:54:28', tz);
    });
  });

  it('names the update set from the defaults and links every record to it', () => {
    const { updateSet, items } = build(withRecords('A'));
    assert.strictEqual(updateSet.name, 'test-v1.2.3');
    assert.strictEqual(updateSet.application_version, '1.2.3');
    assert.strictEqual(items[0].remote_update_set._, SET_ID);
    assert.strictEqual(items[0].payload_hash, 0);
  });

  it('produces XML that round-trips: payloads are escaped, authorship is normalized everywhere', async () => {
    const dir = withRecords('A');
    const loaded = P.load(dir);
    const xml = P.toXml(P.build(loaded, { now }), loaded.defaults);
    assert.deepStrictEqual(await P.verifyXml(xml, 1), []);
    assert.ok(!xml.includes('someone-else'));
    const doc = await xml2js.parseStringPromise(xml, { explicitArray: false });
    assert.match(doc.unload.sys_update_xml.payload, /<script>\/\/ A &amp; &lt;tags&gt;/);
  });

  it('verifyXml catches a broken payload and a wrong record count', async () => {
    const loaded = P.load(withRecords('A'));
    const xml = P.toXml(P.build(loaded, { now }), loaded.defaults).replace('<record_update>', '<record_update><oops>');
    const problems = await P.verifyXml(xml, 2);
    assert.ok(problems.some((p) => /expected 2/.test(p)));
    assert.ok(problems.some((p) => /not well-formed/.test(p)));
  });
});

describe('packager: command line', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'package.js'), ...args], { encoding: 'utf8' });

  it('exits non-zero and lists the problems when the input is bad', () => {
    const r = run(`--from=${fixture({ 'A.yaml': record('A') })}`, `--out=${fs.mkdtempSync(path.join(os.tmpdir(), 'out-'))}`);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /package failed with 1 problem/);
  });

  it('rejects unknown options and empty values instead of guessing', () => {
    assert.strictEqual(run('--release=false').status, 1);
    assert.match(run('--release=false').stderr, /unknown argument/);
    assert.match(run('--from=').stderr, /--from needs a value/);
    assert.match(run('--now=yesterday').stderr, /not a valid date/);
  });

  it('builds a package and exits 0', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
    const r = run(`--from=${withRecords('A')}`, `--out=${out}`, '--now=2026-10-08T17:03:12Z');
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(out, 'test-v1.2.3.xml')));
  });

  it('builds this project\'s own packages: no id shared with the integration app\'s, none duplicated', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
    const r = run(`--out=${out}`);
    assert.strictEqual(r.status, 0, r.stderr);
    const ids = []; const setIds = [];
    for (const f of fs.readdirSync(out)) {
      const doc = await xml2js.parseStringPromise(fs.readFileSync(path.join(out, f), 'utf8'), { explicitArray: false });
      setIds.push(doc.unload.sys_remote_update_set.sys_id, doc.unload.sys_remote_update_set.remote_sys_id);
      [].concat(doc.unload.sys_update_xml).forEach((x) => ids.push(x.sys_id));
    }
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.ok(!ids.some((id) => /^0+\d*$/.test(id)), 'index-based ids would collide with the app\'s own update set');
    assert.ok(!setIds.includes('16199b61975701106115bbc3f153af2d') && !setIds.includes('2df89f61975701106115bbc3f153af79'), 'must not reuse the app\'s update set ids');
    assert.strictEqual(new Set(setIds).size, setIds.length);
  });
});

// Characterization against the integration app's own release. Skipped when that checkout is not next to this project.
const APP_REPO = path.join(ROOT, '..', 'integration-servicenow-app');
const RELEASE_COMMIT = 'bd9edf03';
const haveApp = fs.existsSync(path.join(APP_REPO, '.git')) && (() => { try { execSync(`git -C "${APP_REPO}" cat-file -e ${RELEASE_COMMIT}:releases/pagerduty-v8.4.3.xml`, { stdio: 'ignore' }); return true; } catch (e) { return false; } })();

(haveApp ? describe : describe.skip)('packager vs the app\'s committed release (pagerduty-v8.4.3.xml)', function () {
  this.timeout(120000);

  it('reproduces it record for record, apart from the known drift between that release and the source', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-'));
    execSync(`git -C "${APP_REPO}" archive ${RELEASE_COMMIT} src | tar -x -C "${tmp}"`);
    const releaseXml = execSync(`git -C "${APP_REPO}" show ${RELEASE_COMMIT}:releases/pagerduty-v8.4.3.xml`, { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');

    // the exclusions of the app's `package --release`
    const exclude = [
      { targetNameStartsWith: 'Request Receiver' }, { targetNameIncludes: 'request_receiver' },
      ...['Parameter Variable', 'Test', 'Test Run Data Set', 'Test Step', 'Test Step Config', 'Test Suite', 'Test Suite Test', 'Test Template', 'Input Variables'].map((type) => ({ type })),
      { type: 'Script Include', targetNameIncludes: 'PagerDutyAPIMockUtil' }, { type: 'Script Include', targetNameIncludes: 'PagerDutyOAuthMockUtil' },
      { targetNameIncludes: '(ATF)' }, { type: 'System Property', targetNameIncludes: 'x_pd_integration.rest_mock_api_endpoint' }
    ];
    const loaded = P.load(path.join(tmp, 'src'), { exclude });
    const built = P.build(loaded, { legacy: true, now: new Date('2026-06-17T17:54:28Z') });
    const ours = new Map(built.items.map((i) => [i.name, i]));
    const mine = P.toXml({ updateSet: built.updateSet, items: built.items }, loaded.defaults);

    const parse = async (x) => {
      const d = await xml2js.parseStringPromise(x, { explicitArray: false });
      return { set: d.unload.sys_remote_update_set, recs: new Map([].concat(d.unload.sys_update_xml).map((r) => [r.name, r])) };
    };
    const [rel, out] = [await parse(releaseXml), await parse(mine)];
    const ignore = ['sys_id', 'sys_recorded_at', 'sys_created_on', 'sys_updated_on'];
    const differs = (a, b) => Object.keys(Object.assign({}, a, b)).filter((k) => !ignore.includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));

    assert.deepStrictEqual(differs(rel.set, out.set), [], 'update set record');
    assert.strictEqual(ours.size, out.recs.size);
    const onlyInSource = [...out.recs.keys()].filter((n) => !rel.recs.has(n));
    const onlyInRelease = [...rel.recs.keys()].filter((n) => !out.recs.has(n));
    const changed = [...rel.recs.keys()].filter((n) => out.recs.has(n) && differs(rel.recs.get(n), out.recs.get(n)).length);
    // Drift in the committed release: it was built before these source changes (see docs/PACKAGER.md).
    assert.deepStrictEqual(onlyInRelease, []);
    assert.strictEqual(onlyInSource.length, 3);
    assert.strictEqual(changed.length, 23);
  });
});
