// Runs the real renotify_dialog (html + client script) in a simulated browser with a fake Ajax API.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const jqueryFactory = require('jquery');

const PAGES = path.join(__dirname, '..', 'src', 'Forms & UI', 'UI Pages');
const html = fs.readFileSync(path.join(PAGES, 'renotify_dialog.html'), 'utf8');
const script = fs.readFileSync(path.join(PAGES, 'renotify_dialog.js'), 'utf8');
// the page is Jelly: keep the form, drop the template expressions
const form = /<form[\s\S]*<\/form>/.exec(html)[0].replace(/\$\{HTML:[^}]+\}/g, '');

async function mount({ policies = [], people = [], failPolicies = false, failPeople = false, holdActions = false, holdLists = false } = {}) {
  const dom = new JSDOM(`<body>${form}</body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.jQuery = jqueryFactory(window);
  const calls = [];
  const messages = { info: [], error: [] };
  const timers = [];
  let nextTimer = 1;
  const realSetTimeout = window.setTimeout.bind(window);
  // only the dialog's refresh timer is captured; jQuery's own ready scheduling must run normally
  window.setTimeout = (fn, ms) => {
    if (ms !== 5000) return realSetTimeout(fn, ms);
    timers.push({ id: nextTimer, fn, ms, live: true });
    return nextTimer++;
  };
  window.clearTimeout = (id) => { const t = timers.find((x) => x.id === id); if (t) t.live = false; };
  const held = [];
  const heldLists = [];
  let listsReleased = false;
  const state = { policies, people };
  const reply = (cb, fail, data) => cb(fail ? { message: 'boom' } : undefined, fail ? undefined : data);
  const api = new Proxy({}, {
    get: (_, method) => (...args) => {
      const cb = args.pop();
      calls.push({ method, args });
      if (method === 'listEscalationPolicies' || method === 'listResponders') {
        const answer = method === 'listResponders'
          ? () => reply(cb, failPeople || state.failPeopleNow, { items: state.people })
          : () => reply(cb, failPolicies, { items: state.policies });
        if (holdLists && !listsReleased) { heldLists.push(answer); return; }
        return answer();
      }
      const answer = () => cb(undefined, { message: `${method} done` });
      if (holdActions) held.push(answer); else answer(); // an action the server is still working on
    }
  });
  let destroyed = false;
  window.GlideModal = { get: () => ({ getPreference: () => 'INC-SYS-ID', destroy: () => { destroyed = true; } }) };
  window.x_pd_integration = { AjaxHelper: { ajaxClientFor: () => api } };
  window.g_form = { addInfoMessage: (m) => messages.info.push(m), addErrorMessage: (m) => messages.error.push(m) };
  window.g_user = { userID: 'SN-USER' };
  window.jslog = () => {};
  window.eval(script);
  await new Promise((resolve) => realSetTimeout(resolve, 20)); // jQuery runs the ready callback on a timer
  const $ = window.jQuery;
  const visible = (sel) => $(sel).css('display') !== 'none';
  const rowsText = (sel) => $(sel + ' tr').map((_, tr) => $(tr).children('td').map((__, td) => $(td).text()).get().join(' | ')).get();
  const choose = (value) => { $('.pd-renotify-select').val(value).trigger('change'); };
  const go = () => $('.pd-renotify-go').trigger('click');
  const status = () => $('.pd-renotify-status').text();
  const badges = () => $('.pd-renotify-status .pd-status-head .pd-badge').map((_, b) => $(b).text()).get();
  const title = () => $('.pd-renotify-status .pd-status-title').text();
  const facts = () => $('.pd-renotify-status .pd-status-facts dt').map((_, dt) => [[$(dt).text(), $(dt).next('dd').text()]]).get().reduce((m, [k, v]) => Object.assign(m, { [k]: v }), {});
  const kind = () => [$('.pd-renotify-status .pd-kind-tag').text(), $('.pd-renotify-status .pd-kind-name').text()].filter(Boolean);
  const tone = () => (/tone-(\w+)/.exec($('.pd-renotify-status').attr('class')) || [])[1];
  const goLabel = () => $('.pd-renotify-go').text();
  const goDisabled = () => $('.pd-renotify-go').prop('disabled');
  const groups = () => $('.pd-renotify-select optgroup').map((_, g) => ({ label: g.label, options: $(g).children('option').map((__, o) => `${o.value}=${o.textContent}`).get() })).get();
  const fireTimers = () => { const live = timers.filter((t) => t.live); live.forEach((t) => { t.live = false; t.fn(); }); return live.length; };
  const liveTimers = () => timers.filter((t) => t.live).length;
  return { $, window, badges, title, facts, kind, tone, loadingVisible: () => visible('.pd-renotify-loading'), release: () => held.splice(0).forEach((f) => f()), releaseLists: () => { listsReleased = true; heldLists.splice(0).forEach((f) => f()); }, calls, messages, state, visible, rowsText, choose, go, status, goLabel, goDisabled, groups, fireTimers, liveTimers, wasDestroyed: () => destroyed, callsTo: (m) => JSON.parse(JSON.stringify(calls.filter((c) => c.method === m))) };
}

const policy = (extra) => Object.assign({ id: 'EP1', text: 'Primary EP', runId: '', runState: '', runLevel: '', runActive: false }, extra);
const person = (extra) => Object.assign({ id: 'U1', text: 'Ada Lovelace', state: 'Declined', via: 'Primary EP' }, extra);
const active = (extra) => policy(Object.assign({ runActive: true, runId: 'RUN1', runState: 'active', runLevel: '2' }, extra));

describe('renotify dialog (real html and script, simulated browser)', () => {
  it('offers policies and individuals in one list with a section each, nothing chosen and the button off', async () => {
    const d = await mount({ policies: [policy()], people: [person(), person({ id: 'U2', text: 'Grace Hopper', state: 'Pending', via: 'individually' })] });
    assert.ok(d.visible('.pd-renotify-picker'));
    assert.strictEqual(d.$('.pd-renotify-select').children('option').first().text(), 'Choose an escalation policy or a person…');
    assert.strictEqual(d.$('.pd-renotify-select').val(), '');
    assert.deepStrictEqual(d.groups(), [
      { label: 'Escalation policies', options: ['policy:EP1=Primary EP'] },
      { label: 'Individuals', options: ['user:U1=Ada Lovelace', 'user:U2=Grace Hopper'] }
    ]);
    assert.ok(d.goDisabled());
    assert.ok(!d.visible('.pd-renotify-message'));
  });

  it('has only the section that has something in it', async () => {
    assert.deepStrictEqual((await mount({ people: [person()] })).groups().map((g) => g.label), ['Individuals']);
    assert.deepStrictEqual((await mount({ policies: [policy()] })).groups().map((g) => g.label), ['Escalation policies']);
  });

  it('says so when nobody has been added', async () => {
    const d = await mount();
    assert.match(d.$('.pd-renotify-message').text(), /Nobody has been added/);
    assert.ok(d.visible('.pd-renotify-message'));
    assert.ok(!d.visible('.pd-renotify-picker') && !d.visible('.pd-renotify-details'));
  });

  it('shows the status of just the chosen policy, and what the button will do', async () => {
    const d = await mount({ policies: [policy(), active({ id: 'EP2', text: 'Second', runLevelCount: 3, runNumLoops: 1, runLoop: '0', runStarted: '2026-10-14 09:00:00', runUpdated: '2026-10-14 09:06:00', runWaiting: [{ name: 'Ada Lovelace', state: 'pending' }, { name: 'Grace Hopper', state: 'declined' }] })] });
    d.choose('policy:EP1');
    assert.deepStrictEqual(d.badges(), ['Not renotified']);
    assert.deepStrictEqual(d.kind(), ['Escalation policy', 'Primary EP']);
    assert.strictEqual(d.goLabel(), 'Renotify');
    assert.ok(!d.goDisabled());
    d.choose('policy:EP2');
    assert.deepStrictEqual(d.badges(), ['Renotifying']);
    assert.deepStrictEqual(d.kind(), ['Escalation policy', 'Second']);
    assert.strictEqual(d.title(), 'Level 2 of 3');
    assert.strictEqual(d.tone(), 'info');
    assert.deepStrictEqual(d.facts(), { Round: '1 of 2', 'Waiting on': 'Ada Lovelace (pending), Grace Hopper (declined)', Started: '2026-10-14 09:00:00', 'Last change': '2026-10-14 09:06:00' });
    assert.strictEqual(d.goLabel(), 'Stop');
  });

  it('shows the status of just the chosen person, with how they were added and when it last changed', async () => {
    const d = await mount({ people: [person({ updated: '2026-10-14 09:05:00' }), person({ id: 'U2', text: 'Grace Hopper', state: 'Pending', via: 'individually' })] });
    d.choose('user:U1');
    assert.deepStrictEqual(d.badges(), ['Declined']);
    assert.strictEqual(d.tone(), 'bad');
    assert.deepStrictEqual(d.kind(), ['Individual', 'Ada Lovelace']);
    assert.deepStrictEqual(d.facts(), { Added: 'Primary EP', 'Last change': '2026-10-14 09:05:00' });
    d.choose('user:U2');
    assert.deepStrictEqual(d.badges(), ['Pending']);
    assert.strictEqual(d.tone(), 'warn');
    assert.deepStrictEqual(d.facts(), { Added: 'individually' });
    assert.strictEqual(d.goLabel(), 'Renotify');
  });

  it('says whether the chosen item is an escalation policy or an individual, and which one', async () => {
    const d = await mount({ policies: [policy(), active({ id: 'EP2', text: 'Second' })], people: [person(), person({ id: 'U2', text: 'Grace Hopper', state: 'Pending' })] });
    const seen = ['policy:EP1', 'policy:EP2', 'user:U1', 'user:U2'].map((v) => { d.choose(v); return d.kind(); });
    assert.deepStrictEqual(seen, [['Escalation policy', 'Primary EP'], ['Escalation policy', 'Second'], ['Individual', 'Ada Lovelace'], ['Individual', 'Grace Hopper']]);
    d.choose('user:U1');
    assert.ok(d.$('.pd-kind-tag').hasClass('individual'));
    d.choose('policy:EP1');
    assert.ok(d.$('.pd-kind-tag').hasClass('policy'));
  });

  it('describes how a finished run ended, with the reason when it failed', async () => {
    const d = await mount({ policies: [policy({ runState: 'joined' }), policy({ id: 'E2', text: 'B', runState: 'exhausted' }), policy({ id: 'E3', text: 'C', runState: 'failed', runError: 'Could not request responders: HTTP 500' }), policy({ id: 'E4', text: 'D', runState: 'cancelled' }), policy({ id: 'E5', text: 'E', runState: 'resolved' })] });
    const said = ['EP1', 'E2', 'E3', 'E4', 'E5'].map((id) => { d.choose('policy:' + id); return [d.badges()[0], d.tone()]; });
    assert.deepStrictEqual(said, [['Someone joined', 'good'], ['Reached the end', 'warn'], ['Failed', 'bad'], ['Stopped', 'muted'], ['Stopped', 'muted']]);
    d.choose('policy:E3');
    assert.strictEqual(d.facts().Error, 'Could not request responders: HTTP 500');
  });

  it('before anything is chosen, summarises what is on the incident', async () => {
    const d = await mount({
      policies: [policy(), active({ id: 'EP2', text: 'Second' })],
      people: [person({ state: 'Pending' }), person({ id: 'U2', text: 'B', state: 'Pending' }), person({ id: 'U3', text: 'C', state: 'Joined' }), person({ id: 'U4', text: 'D', state: 'Declined' }), person({ id: 'U5', text: 'E', state: 'Cancelled' })]
    });
    assert.strictEqual(d.title(), 'Choose something to renotify');
    assert.deepStrictEqual(d.kind(), [], 'nothing is chosen, so there is no kind');
    assert.deepStrictEqual(d.badges(), ['Pending 2', 'Joined 1', 'Declined 1', 'Cancelled 1']);
    assert.strictEqual(d.facts()['Escalation policies'], '2 policies, 1 being renotified now (choose one to renotify it level by level)');
    assert.strictEqual(d.facts().Individuals, '5 people available to renotify');
    assert.strictEqual(d.tone(), 'info');
    d.choose('user:U1');
    d.choose('');
    assert.strictEqual(d.title(), 'Choose something to renotify');
  });

  it('the summary uses singular words and leaves out what there is none of', async () => {
    const d = await mount({ policies: [policy()], people: [person({ state: 'Accepted' })] });
    assert.deepStrictEqual(d.badges(), ['Pending 0', 'Joined 1', 'Declined 0']);
    assert.strictEqual(d.facts()['Escalation policies'], '1 policy (choose one to renotify it level by level)');
    assert.strictEqual(d.facts().Individuals, '1 person available to renotify');
    const people = await mount({ people: [person()] });
    assert.ok(!('Escalation policies' in people.facts()));
  });

  it('shows a loading indicator until the first answer, then the list, and the message when there is nothing', async () => {
    const d = await mount({ policies: [policy()], holdLists: true });
    assert.ok(d.loadingVisible());
    assert.ok(!d.visible('.pd-renotify-picker'));
    d.releaseLists();
    assert.ok(!d.loadingVisible());
    assert.ok(d.visible('.pd-renotify-picker'));
    const empty = await mount();
    assert.ok(!empty.loadingVisible());
    const failed = await mount({ failPolicies: true, failPeople: true });
    assert.ok(!failed.loadingVisible());
  });

  it('does not bring the loading indicator back on a refresh', async () => {
    const d = await mount({ policies: [active({ runLevel: '1' })] });
    d.fireTimers();
    assert.ok(!d.loadingVisible());
  });

  it('renotifies the chosen individual as the current user, confirms, and keeps the choice', async () => {
    const d = await mount({ people: [person({ id: 'U7' })] });
    d.choose('user:U7');
    d.go();
    assert.deepStrictEqual(d.callsTo('renotifyUser').map((c) => c.args), [[{ snIncidentId: 'INC-SYS-ID', pdUserId: 'U7', currentUser: 'SN-USER' }]]);
    assert.deepStrictEqual(d.messages.info, ['renotifyUser done']);
    assert.strictEqual(d.callsTo('listResponders').length, 2);
    assert.strictEqual(d.$('.pd-renotify-select').val(), 'user:U7');
  });

  it('starts a policy, and stops an active one', async () => {
    const d = await mount({ policies: [policy(), active({ id: 'EP2', text: 'Second' })] });
    d.choose('policy:EP1');
    d.go();
    assert.deepStrictEqual(d.callsTo('renotify').map((c) => c.args), [[{ snIncidentId: 'INC-SYS-ID', pdPolicyId: 'EP1', currentUser: 'SN-USER' }]]);
    d.choose('policy:EP2');
    d.go();
    assert.deepStrictEqual(d.callsTo('cancel').map((c) => c.args), [['RUN1']]);
  });

  it('does nothing when nothing is chosen', async () => {
    const d = await mount({ policies: [policy()] });
    d.$('.pd-renotify-go').prop('disabled', false);
    d.go();
    assert.strictEqual(d.calls.filter((c) => /^(renotify|renotifyUser|cancel)$/.test(c.method)).length, 0);
  });

  it('the status follows the run as it proceeds', async () => {
    const d = await mount({ policies: [policy()] });
    d.choose('policy:EP1');
    d.state.policies = [active({ runLevel: '1', runLevelCount: 2, runNumLoops: 0, runLoop: '0' })];
    d.go();
    assert.strictEqual(d.title(), 'Level 1 of 2');
    assert.strictEqual(d.goLabel(), 'Stop');
    d.state.policies = [active({ runLevel: '2', runLevelCount: 2, runNumLoops: 0, runLoop: '0' })];
    d.fireTimers();
    assert.strictEqual(d.title(), 'Level 2 of 2');
    d.state.policies = [policy({ runState: 'joined' })];
    d.fireTimers();
    assert.deepStrictEqual(d.badges(), ['Someone joined']);
    assert.strictEqual(d.goLabel(), 'Renotify');
    assert.strictEqual(d.$('.pd-renotify-select').val(), 'policy:EP1');
  });

  it('shows the full status in a disclosure that starts closed, with no buttons in it', async () => {
    const d = await mount({ policies: [policy(), active({ id: 'EP2', text: 'Second' })], people: [person(), person({ id: 'U2', text: 'Grace Hopper', state: 'Pending', via: 'individually' })] });
    assert.ok(d.visible('.pd-renotify-details'));
    assert.strictEqual(d.$('.pd-renotify-details')[0].open, false);
    assert.deepStrictEqual(d.rowsText('.pd-renotify-rows'), ['Primary EP | Not renotified', 'Second | Renotifying: level 2']);
    assert.deepStrictEqual(d.rowsText('.pd-renotify-people-rows'), ['Ada Lovelace | Declined | Primary EP', 'Grace Hopper | Pending | individually']);
    assert.strictEqual(d.$('.pd-renotify-details button').length, 0);
  });

  it('keeps the disclosure to the sections that have rows', async () => {
    const d = await mount({ people: [person()] });
    assert.ok(!d.visible('.pd-renotify-table') && d.visible('.pd-renotify-people'));
    const p = await mount({ policies: [policy()] });
    assert.ok(p.visible('.pd-renotify-table') && !p.visible('.pd-renotify-people'));
  });

  it('reports a failed list but still offers the other section', async () => {
    const d = await mount({ policies: [policy()], failPeople: true });
    assert.deepStrictEqual(d.messages.error, ['boom']);
    assert.deepStrictEqual(d.groups().map((g) => g.label), ['Escalation policies']);
  });

  it('shows a plain message when nothing could be loaded', async () => {
    const d = await mount({ failPolicies: true, failPeople: true });
    assert.match(d.$('.pd-renotify-message').text(), /Could not load/);
    assert.ok(!d.visible('.pd-renotify-picker'));
  });

  it('a refresh that cannot read a list keeps what was shown, and the choice', async () => {
    const d = await mount({ policies: [active({ runLevel: '1' })], people: [person()] });
    d.choose('user:U1');
    d.state.failPeopleNow = true;
    d.state.policies = [active({ runLevel: '2' })];
    d.fireTimers();
    assert.deepStrictEqual(d.messages.error, ['boom']);
    assert.strictEqual(d.$('.pd-renotify-select').val(), 'user:U1');
    assert.deepStrictEqual(d.badges(), ['Declined']);
    assert.deepStrictEqual(d.rowsText('.pd-renotify-rows'), ['Primary EP | Renotifying: level 2']);
  });

  it('keeps refreshing while a run is active or a request is pending, and stops when nothing is waiting', async () => {
    const d = await mount({ policies: [active({ runLevel: '1' })] });
    assert.strictEqual(d.liveTimers(), 1);
    d.state.policies = [policy({ runState: 'joined' })];
    d.fireTimers();
    assert.strictEqual(d.liveTimers(), 0, 'nothing waiting any more');
    assert.strictEqual((await mount({ people: [person({ state: 'Pending' })] })).liveTimers(), 1);
    assert.strictEqual((await mount({ people: [person({ state: 'Accepted' })], policies: [policy()] })).liveTimers(), 0);
  });

  it('a refresh does not rebuild the list or lose the choice, so it cannot close a list the person has open', async () => {
    const d = await mount({ policies: [active({ runLevel: '1' })], people: [person()] });
    d.choose('user:U1');
    d.$('.pd-renotify-select option').each((_, o) => { o.dataset.seen = '1'; });
    d.state.policies = [active({ runLevel: '2' })];
    d.fireTimers();
    assert.strictEqual(d.$('.pd-renotify-select option[data-seen]').length, d.$('.pd-renotify-select option').length, 'the same option elements');
    assert.strictEqual(d.$('.pd-renotify-select').val(), 'user:U1');
  });

  it('rebuilds the list when someone is added, and keeps the choice', async () => {
    const d = await mount({ policies: [active({ runLevel: '1' })], people: [person()] });
    d.choose('user:U1');
    d.state.people = [person(), person({ id: 'U2', text: 'Grace Hopper' })];
    d.fireTimers();
    assert.deepStrictEqual(d.groups()[1].options, ['user:U1=Ada Lovelace', 'user:U2=Grace Hopper']);
    assert.strictEqual(d.$('.pd-renotify-select').val(), 'user:U1');
  });

  it('goes back to nothing chosen when the chosen item disappears', async () => {
    const d = await mount({ policies: [active({ runLevel: '1' })], people: [person()] });
    d.choose('user:U1');
    d.state.people = [];
    d.fireTimers();
    assert.strictEqual(d.$('.pd-renotify-select').val(), '');
    assert.ok(d.goDisabled());
  });

  it('stops refreshing once the dialog is gone', async () => {
    const d = await mount({ people: [person({ state: 'Pending' })] });
    d.$('.pd-renotify-form').remove();
    const before = d.callsTo('listResponders').length;
    d.fireTimers();
    assert.strictEqual(d.callsTo('listResponders').length, before);
    assert.strictEqual(d.liveTimers(), 0);
  });

  it('disables the list and the button while an action is being handled, and ignores a second click', async () => {
    const d = await mount({ people: [person(), person({ id: 'U2', text: 'Grace' })], holdActions: true });
    d.choose('user:U1');
    d.go();
    assert.ok(d.goDisabled());
    assert.ok(d.$('.pd-renotify-select').prop('disabled'));
    d.$('.pd-renotify-go').prop('disabled', false);
    d.go(); // even if a click got through
    assert.strictEqual(d.callsTo('renotifyUser').length, 1);
    d.release();
    assert.ok(!d.goDisabled());
    assert.ok(!d.$('.pd-renotify-select').prop('disabled'));
    d.choose('user:U2');
    d.go();
    assert.strictEqual(d.callsTo('renotifyUser').length, 2);
  });

  it('after renotifying a person says the request is on its way until PagerDuty\'s answer arrives, then shows the new state', async () => {
    const d = await mount({ people: [person({ state: 'Declined' })] });
    assert.strictEqual(d.liveTimers(), 0, 'nothing is waiting before the click');
    d.choose('user:U1');
    d.go();
    assert.deepStrictEqual(d.badges(), ['Request sent']);
    assert.strictEqual(d.title(), 'Waiting for PagerDuty…');
    assert.strictEqual(d.tone(), 'info');
    assert.strictEqual(d.liveTimers(), 1, 'a refresh is scheduled although nobody is pending yet');
    d.fireTimers();                                                    // the webhook has not arrived yet
    assert.deepStrictEqual(d.badges(), ['Request sent']);
    assert.deepStrictEqual(d.rowsText('.pd-renotify-people-rows'), ['Ada Lovelace | Request sent, waiting for PagerDuty… | Primary EP']);
    d.state.people = [person({ state: 'Pending' })];                   // ...and now it has
    d.fireTimers();
    assert.deepStrictEqual(d.badges(), ['Pending']);
    assert.deepStrictEqual(d.kind(), ['Individual', 'Ada Lovelace']);
    assert.strictEqual(d.liveTimers(), 1, 'a pending request is still followed');
  });

  it('does not claim a request is on its way for someone who was already pending', async () => {
    const d = await mount({ people: [person({ state: 'Pending' })] });
    d.choose('user:U1');
    d.go();
    assert.deepStrictEqual(d.badges(), ['Pending']);
  });

  it('gives up waiting for the answer after about 30 seconds and shows what PagerDuty says', async () => {
    const d = await mount({ people: [person({ state: 'Declined' })] });
    d.choose('user:U1');
    d.go();
    let fires = 0;
    while (d.liveTimers() && fires < 20) { d.fireTimers(); fires++; }
    assert.ok(fires >= 5 && fires <= 8, `refreshed ${fires} times`);
    assert.deepStrictEqual(d.badges(), ['Declined']);
  });

  it('keeps refreshing after Stop and after starting a policy, so the status catches up', async () => {
    const d = await mount({ policies: [policy(), active({ id: 'EP2', text: 'Second', runLevel: '1' })] });
    d.choose('policy:EP2');
    d.go();
    d.state.policies = [policy(), policy({ id: 'EP2', text: 'Second', runState: 'cancelled' })];
    d.fireTimers();
    assert.deepStrictEqual(d.badges(), ['Stopped']);
    assert.strictEqual(d.goLabel(), 'Renotify');
  });

  it('shows a small spinner in the status while an action is being handled', async () => {
    const d = await mount({ policies: [policy()], holdActions: true });
    d.choose('policy:EP1');
    d.go();
    assert.strictEqual(d.$('.pd-renotify-status .pd-renotify-spinner').length, 1);
    d.release();
    assert.strictEqual(d.$('.pd-renotify-status .pd-renotify-spinner').length, 0);
  });

  it('Close stops the refresh and closes the dialog', async () => {
    const d = await mount({ people: [person({ state: 'Pending' })] });
    d.$('button.submit-cancel').trigger('click');
    assert.ok(d.wasDestroyed());
    assert.strictEqual(d.liveTimers(), 0);
  });
});
