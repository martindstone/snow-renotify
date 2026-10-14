// Runs the real PagerDutyRenotify Script Include (from src/) against fake ServiceNow globals and a fake PagerDuty.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeStore } = require('./support/platform');

const SI_DIR = path.join(__dirname, '..', 'src', 'Server Development', 'Script Includes');
const available = fs.existsSync(path.join(SI_DIR, 'PagerDutyRenotify.js'));

function makeWorld() {
  const { tables, rowsOf, GR } = makeStore();

  // Fake PagerDuty: one policy, mutable on-calls, records responder requests.
  const pd = { policy: null, oncalls: [], requests: [], postFails: false, oncallQueries: [], cancels: [], cancelFails: false, order: [], users: {}, policies: {}, incidentResponders: [], incidentFails: false, incidentReads: 0 };
  const result = (status, body) => ({ getStatusCode: () => status, haveError: () => status >= 400, getErrorMessage: () => 'HTTP ' + status, getBody: () => JSON.stringify(body) });
  class FakeRest {
    hasError() { return false; }
    getError() { return ''; }
    getREST(feature, params) {
      // Like the platform's REST client: a raw '[' or ']' anywhere in the URL or in a parameter name is "Invalid query".
      if (/[\[\]]/.test(feature) || Object.keys(params || {}).some((k) => /[\[\]]/.test(k))) return result(400, { error: 'Invalid query' });
      const [route, query = ''] = feature.split('?');
      const q = new URLSearchParams(query);
      if (route === 'incidents/PINC') {
        pd.incidentReads++;
        if (pd.incidentFails) return result(500, { error: 'boom' });
        return result(200, { incident: { id: 'PINC', incidents_responders: pd.incidentResponders } });
      }
      if (route.indexOf('users/') === 0) return pd.users[route.slice(6)] ? result(200, { user: { name: pd.users[route.slice(6)] } }) : result(404, {});
      if (route.indexOf('escalation_policies/') === 0) {
        const id = route.slice('escalation_policies/'.length);
        if (pd.policies[id]) return result(200, { escalation_policy: { id, name: pd.policies[id] } });
        return pd.policy && pd.policy.id === id ? result(200, { escalation_policy: pd.policy }) : result(404, {});
      }
      if (route === 'oncalls') {
        pd.oncallQueries.push(query);
        if (pd.oncallsStatus) return result(pd.oncallsStatus, { error: 'refused' });
        if (q.get('escalation_policy_ids[]') !== pd.policy.id) return result(200, { oncalls: [], more: false });
        return result(200, { oncalls: pd.oncalls, more: false });
      }
      return result(404, {});
    }
    putREST(feature, body, from) {
      pd.order.push('cancel');
      pd.cancels.push({ feature, from, requester: body.requester_id, targets: body.responder_request_targets });
      if (pd.cancelFails) return result(500, { error: 'cancel failed' });
      return result(200, { responder_request_targets: body.responder_request_targets.map((t) => Object.assign({ result: 'cancelled' }, t)) });
    }
    postREST(feature, body, from) {
      if (pd.postFails) return result(500, { error: 'boom' });
      pd.order.push('request:' + body.responder_request_targets.map((t) => t.responder_request_target.id).join('+'));
      pd.requests.push({ feature, users: body.responder_request_targets.map((t) => t.responder_request_target.id), from, requester: body.requester_id });
      return result(200, {});
    }
  }

  const events = [];
  const props = { 'x_pd_integration.default_user': 'DEFAULT' };
  const ctx = {
    Class: { create() { return function () { if (this.initialize) this.initialize.apply(this, arguments); }; } },
    gs: { nil: (x) => x === undefined || x === null || x === '', getProperty: (n) => props[n], debug() {}, info() {}, warn() {}, error() {}, eventQueue: (name, gr, p1) => events.push({ name, id: p1 }) },
    GlideRecord: function (t) { return new GR(t); },
    GlideRecordSecure: function (t) { return new GR(t); },
    JSON, Date, Error, isNaN, String, Object, Array,
    x_pd_integration: {
      PagerDuty: function () { return { getUserIDFromFieldData: (id) => (id === 'snuser' ? 'REQ' : null), getUserEmailByPDID: (id) => id.toLowerCase() + '@example.com' }; },
      PagerDuty_REST: FakeRest,
      AjaxHelper: { createAjaxController: (definition) => definition } // the controller's methods, callable directly
    }
  };
  vm.createContext(ctx);
  ['PagerDutyRenotifyMachine', 'PagerDutyRenotify', 'PagerDutyRenotifyController'].forEach((n) => {
    vm.runInContext(fs.readFileSync(path.join(SI_DIR, n + '.js'), 'utf8') + `\nthis.${n} = ${n};`, ctx);
    ctx.x_pd_integration[n] = ctx[n];
  });
  const incident = new GR('incident'); incident.initialize(); incident.setValue('x_pd_integration_incident', 'PINC'); incident.insert();
  return { ctx, pd, events, tables, props, snIncidentId: incident.getUniqueValue(), result, rowsOf };
}

const MIN = 60000;
const plain = (x) => JSON.parse(JSON.stringify(x));
const oc = (level, id) => ({ escalation_level: level, user: { id } });
const reply = (user, state, atMs) => ({ event_type: 'incident.responder.replied', occurred_at: new Date(atMs).toISOString(), data: { type: 'incident_responder', incident: { id: 'PINC' }, user: { id: user }, state } });

(available ? describe : describe.skip)('PagerDutyRenotify executor (real Script Include, fake platform)', () => {
  let w, w2, svc, clock;
  const run = () => w.rowsOf('x_pd_integration_renotify_run')[0];
  beforeEach(() => {
    w = makeWorld();
    w.pd.policy = { id: 'EP', name: 'Test EP', num_loops: 0, escalation_rules: [{ escalation_delay_in_minutes: 15 }, { escalation_delay_in_minutes: 15 }, { escalation_delay_in_minutes: 15 }] };
    w.pd.oncalls = [oc(1, 'A'), oc(2, 'B'), oc(3, 'C')];
    svc = new w.ctx.x_pd_integration.PagerDutyRenotify();
    clock = 1000000;
    svc._now = () => clock;
  });
  const advance = (min) => { clock += min * MIN; };
  const flushQueued = () => { while (w.events.length) svc.flush(w.events.shift().id); };

  it('start requests only level 1, as the clicking user', () => {
    const r = svc.start(w.snIncidentId, 'EP', 'snuser');
    assert.strictEqual(r.policyName, 'Test EP');
    assert.deepStrictEqual(plain(w.pd.requests), [{ feature: 'incidents/PINC/responder_requests', users: ['A'], from: 'req@example.com', requester: 'REQ' }]);
    assert.strictEqual(run().state, 'active');
    assert.strictEqual(run().active, '1');
    assert.strictEqual(run().level, '1');
  });


  it('asks PagerDuty for on-calls with an encoded query the platform accepts, scoped to the policy', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    assert.deepStrictEqual(plain(w.pd.oncallQueries), ['escalation_policy_ids%5B%5D=EP&limit=100&offset=0']);
    assert.strictEqual(run().state, 'active');
  });

  it('a run that times out on its last level is saved as exhausted and stops being active', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');            // level 1, 15 minutes
    advance(15); svc.tick();                              // level 2
    advance(15); svc.tick();                              // level 3
    advance(15); svc.tick();                              // nothing left: exhausted, with nothing to send
    assert.strictEqual(run().state, 'exhausted');
    assert.strictEqual(run().active, '0');
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['A'], ['B'], ['C']]);
    advance(60); svc.tick();
    assert.strictEqual(w.pd.requests.length, 3, 'nothing more is requested');
  });

  it('a tick that changes nothing does not rewrite the run', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    const before = run().sys_updated_on;
    advance(1); svc.tick();
    assert.strictEqual(run().sys_updated_on, before);
  });

  it('a run with loops is exhausted only after its last loop', () => {
    w.pd.policy = { id: 'EP', name: 'Test EP', num_loops: 1, escalation_rules: [{ escalation_delay_in_minutes: 1 }, { escalation_delay_in_minutes: 1 }] };
    svc.start(w.snIncidentId, 'EP', 'snuser');
    for (let i = 0; i < 3; i++) { advance(1); svc.tick(); }
    assert.strictEqual(run().state, 'active');
    assert.strictEqual(run().loop, '1');
    advance(1); svc.tick();
    assert.strictEqual(run().state, 'exhausted');
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['A'], ['B'], ['A'], ['B']]);
  });

  it('refuses a second run for the same incident and policy while one is active', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    assert.throws(() => svc.start(w.snIncidentId, 'EP', 'snuser'), /already being renotified/);
  });

  it('a decline reply queues an event, and flushing it requests level 2 once', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    svc.handleReplyEvent(reply('A', 'declined', clock + 1000));
    assert.strictEqual(w.events.length, 1);
    flushQueued();
    flushQueued();
    assert.deepStrictEqual(plain(w.pd.requests.map((x) => x.users)), [['A'], ['B']]);
    assert.strictEqual(run().level, '2');
  });

  it('a duplicate webhook delivery does not request level 2 twice', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    const ev = reply('A', 'declined', clock + 1000);
    svc.handleReplyEvent(ev);
    svc.handleReplyEvent(ev);
    flushQueued();
    assert.deepStrictEqual(plain(w.pd.requests.map((x) => x.users)), [['A'], ['B']]);
  });


  it('two users on a level replying before the flush still advance exactly once', () => {
    w.pd.oncalls = [oc(1, 'A1'), oc(1, 'A2'), oc(2, 'B'), oc(3, 'C')];
    svc.start(w.snIncidentId, 'EP', 'snuser');
    svc.handleReplyEvent(reply('A1', 'declined', clock + 1000));
    svc.handleReplyEvent(reply('A2', 'declined', clock + 1500));
    flushQueued();
    assert.deepStrictEqual(plain(w.pd.requests.map((x) => x.users)), [['A1', 'A2'], ['B']]);
  });

  it('tick recovers a run left waiting to resolve a level after a failed flush', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    svc.handleReplyEvent(reply('A', 'declined', clock + 1000));
    run().pending_actions = ''; // simulate a flush that claimed the action and died
    svc.tick();
    assert.deepStrictEqual(plain(w.pd.requests.map((x) => x.users)), [['A'], ['B']]);
  });

  it('a join stops the run and sends nothing more', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    svc.handleReplyEvent(reply('A', 'joined', clock + 1000));
    assert.strictEqual(w.events.length, 0);
    assert.strictEqual(run().state, 'joined');
    assert.strictEqual(run().active, '0');
    advance(60); svc.tick();
    assert.strictEqual(w.pd.requests.length, 1);
  });

  it('purgeFinishedRuns deletes finished runs older than the retention period, never active ones or young ones', () => {
    const insert = (fields) => {
      const g = new w.ctx.GlideRecord('x_pd_integration_renotify_run');
      g.initialize();
      Object.keys(fields).forEach((k) => g.setValue(k, fields[k]));
      g.insert();
      g.row.sys_updated_on = fields.sys_updated_on;
    };
    const when = (daysAgo) => new Date(clock - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    insert({ pd_incident_id: 'I1', state: 'joined', active: false, sys_updated_on: when(40) });
    insert({ pd_incident_id: 'I2', state: 'active', active: true, sys_updated_on: when(40) });
    insert({ pd_incident_id: 'I3', state: 'joined', active: false, sys_updated_on: when(2) });
    assert.strictEqual(svc.purgeFinishedRuns(0), 0, '0 keeps everything');
    assert.strictEqual(svc.purgeFinishedRuns(30), 1, 'only the old finished one');
    assert.deepStrictEqual(w.rowsOf('x_pd_integration_renotify_run').map((r) => r.pd_incident_id), ['I2', 'I3']);
    assert.strictEqual(svc.purgeFinishedRuns(30, 'I3'), 0);
    assert.strictEqual(svc.purgeFinishedRuns(1, 'I3'), 1, 'limited to one incident');
  });

  it('purgeFinishedRuns uses the property, then 30 days, and ignores a value that is not a number', () => {
    w.pd.policy = { id: 'EP', name: 'x', num_loops: 0, escalation_rules: [{ escalation_delay_in_minutes: 1 }] };
    svc.start(w.snIncidentId, 'EP', 'snuser');
    svc.handleReplyEvent(reply('A', 'joined', clock + 1000));
    w.rowsOf('x_pd_integration_renotify_run')[0].sys_updated_on = new Date(clock - 40 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    w.props['x_pd_integration.renotify_run_retention_days'] = '60';
    assert.strictEqual(svc.purgeFinishedRuns(), 0, 'kept: 40 days is within 60');
    w.props['x_pd_integration.renotify_run_retention_days'] = 'soon';
    assert.strictEqual(svc.purgeFinishedRuns(), 1, 'falls back to 30 days');
  });

  it('the tick purges only in the first minutes after 03:00 UTC, and a failing purge does not break it', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    svc.handleReplyEvent(reply('A', 'joined', clock + 1000));
    w.rowsOf('x_pd_integration_renotify_run')[0].sys_updated_on = '2026-01-01 00:00:00';
    clock = Date.UTC(2026, 9, 14, 12, 0, 0); svc.tick();
    assert.strictEqual(w.rowsOf('x_pd_integration_renotify_run').length, 1, 'noon: nothing is purged');
    clock = Date.UTC(2026, 9, 14, 3, 6, 0); svc.tick();
    assert.strictEqual(w.rowsOf('x_pd_integration_renotify_run').length, 1, '03:06 is outside the window');
    svc.purgeFinishedRuns = () => { throw new Error('boom'); };
    clock = Date.UTC(2026, 9, 14, 3, 1, 0); svc.tick();                      // must not throw
    delete svc.purgeFinishedRuns;
    svc.tick();
    assert.strictEqual(w.rowsOf('x_pd_integration_renotify_run').length, 0, '03:01 purges');
  });

  it('tick can be limited to one PagerDuty incident, leaving other runs alone', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    advance(15); svc.tick('SOMEONE-ELSE');
    assert.strictEqual(w.pd.requests.length, 1);
    svc.tick('PINC');
    assert.strictEqual(w.pd.requests.length, 2);
  });

  it('tick advances only after the level delay', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    advance(14); svc.tick();
    assert.strictEqual(w.pd.requests.length, 1);
    advance(1); svc.tick();
    assert.deepStrictEqual(plain(w.pd.requests.map((x) => x.users)), [['A'], ['B']]);
  });

  it('resolves on-calls when the level is reached (shift change)', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    w.pd.oncalls = [oc(1, 'A'), oc(2, 'B2'), oc(3, 'C')];
    advance(15); svc.tick();
    assert.deepStrictEqual(plain(w.pd.requests[1].users), ['B2']);
  });

  it('ignores a reply that predates the current level request', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    svc.handleReplyEvent(reply('A', 'declined', clock + 1000)); flushQueued();
    advance(1);
    svc.handleReplyEvent(reply('B', 'joined', clock - 5 * MIN));
    assert.strictEqual(run().state, 'active');
  });

  it('incident.resolved ends the run', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    svc.handleResolvedEvent({ event_type: 'incident.resolved', data: { id: 'PINC' } });
    assert.strictEqual(run().state, 'resolved');
    assert.strictEqual(run().active, '0');
  });

  it('a PagerDuty failure on start throws and marks the run failed', () => {
    w.pd.postFails = true;
    assert.throws(() => svc.start(w.snIncidentId, 'EP', 'snuser'), /Could not request responders/);
    assert.strictEqual(run().state, 'failed');
    assert.strictEqual(run().active, '0');
    assert.ok(run().last_error);
  });

  it('when PagerDuty refuses the on-calls request, the failure points at the oncalls.read OAuth scope', () => {
    w.pd.oncallsStatus = 403;
    assert.throws(() => svc.start(w.snIncidentId, 'EP', 'snuser'), /refused the request \(HTTP 403\).*oncalls\.read/);
    assert.strictEqual(run().state, 'failed');
    assert.match(run().last_error, /oncalls\.read/);
    assert.strictEqual(w.pd.requests.length, 0);
  });

  it('a 401 gets the same hint, and other failures do not', () => {
    w.pd.oncallsStatus = 401;
    assert.throws(() => svc.start(w.snIncidentId, 'EP', 'snuser'), /oncalls\.read/);
    w2 = makeWorld();
    w2.pd.policy = w.pd.policy; w2.pd.oncallsStatus = 500;
    const svc2 = new w2.ctx.x_pd_integration.PagerDutyRenotify(); svc2._now = () => clock;
    assert.throws(() => svc2.start(w2.snIncidentId, 'EP', 'snuser'), (e) => /Could not fetch on-calls/.test(e.message) && !/oncalls\.read/.test(e.message));
  });

  it('a user with no PagerDuty mapping is rejected before anything is sent', () => {
    assert.throws(() => svc.start(w.snIncidentId, 'EP', 'unknown'), /not mapped/);
    assert.strictEqual(w.pd.requests.length, 0);
  });

  it('cancel stops an active run', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    svc.cancel(run().sys_id);
    assert.strictEqual(run().state, 'cancelled');
    advance(60); svc.tick();
    assert.strictEqual(w.pd.requests.length, 1);
  });

  // ---- do not ask twice: PagerDuty's own escalation may already have asked someone for this level
  const asked = (user, atMs, state = 'pending') => ({ user: { id: user }, state, requested_at: new Date(atMs).toISOString() });

  it('does not ask someone PagerDuty itself requested just after the level became due, but still waits for their answer', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    const declinedAt = clock + 1000; // PagerDuty's timestamp of the decline
    w.pd.incidentResponders = [asked('B', declinedAt)]; // PagerDuty escalated to level 2 in the same second
    advance(0.2); // ServiceNow processes the event a few seconds later
    svc.handleReplyEvent(reply('A', 'declined', declinedAt)); flushQueued();
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['A']], 'B was not asked again');
    assert.strictEqual(run().level, '2');
    svc.handleReplyEvent(reply('B', 'joined', declinedAt + 5000));
    assert.strictEqual(run().state, 'joined', 'their answer still ends the run');
  });

  it('asks someone whose pending request is older than the moment the level became due', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    w.pd.incidentResponders = [asked('B', clock - 600000)]; // pending for ten minutes, never answered
    svc.handleReplyEvent(reply('A', 'declined', clock + 1000)); flushQueued();
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['A'], ['B']]);
  });

  it('asks again someone whose native request came before the click (that is what Renotify is for)', () => {
    w.pd.incidentResponders = [asked('A', clock - 30000)];
    svc.start(w.snIncidentId, 'EP', 'snuser');
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['A']]);
  });

  it('skips only the people PagerDuty already asked, in a level with several', () => {
    w.pd.oncalls = [oc(1, 'A'), oc(2, 'B1'), oc(2, 'B2')];
    svc.start(w.snIncidentId, 'EP', 'snuser');
    w.pd.incidentResponders = [asked('B1', clock + 1000)];
    svc.handleReplyEvent(reply('A', 'declined', clock + 1000)); flushQueued();
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['A'], ['B2']]);
    assert.deepStrictEqual(Object.keys(JSON.parse(run().run_json).responses).sort(), ['B1', 'B2']);
  });

  it('ignores a responder who already answered, or one asked after a timeout was due only by a long way', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    w.pd.incidentResponders = [asked('B', clock + 1000, 'declined')];
    svc.handleReplyEvent(reply('A', 'declined', clock + 1000)); flushQueued();
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['A'], ['B']]);
  });

  it('uses the moment the delay expired when a level times out', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    advance(16);
    w.pd.incidentResponders = [asked('B', clock - 60000 + 500)]; // asked 0.5s after the 15-minute delay expired, a minute before the tick noticed
    svc.tick();
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['A']], 'B was not asked again');
  });

  it('asks everyone when PagerDuty cannot be read', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    w.pd.incidentFails = true;
    w.pd.incidentResponders = [asked('B', clock + 1000)];
    svc.handleReplyEvent(reply('A', 'declined', clock + 1000)); flushQueued();
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['A'], ['B']]);
  });

  it('never skips the one-off renotify of a person, and does not read the incident for it', () => {
    w.pd.incidentResponders = [asked('U9', clock + 1000)];
    svc.renotifyUser(w.snIncidentId, 'U9', 'snuser');
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['U9']]);
    assert.strictEqual(w.pd.incidentReads, 0);
  });

  it('does not call PagerDuty\'s cancel endpoint any more', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    assert.deepStrictEqual(plain(w.pd.cancels), []);
  });

  it('uses the collaborators it is given instead of the platform\'s (how the ATF tests run without PagerDuty)', () => {
    const calls = [];
    const rest = () => ({
      hasError: () => false, getError: () => '',
      getREST: (f) => (/^escalation_policies\//.test(f)
        ? { haveError: () => false, getBody: () => JSON.stringify({ escalation_policy: { id: 'X', name: 'Mine', num_loops: 0, escalation_rules: [{ escalation_delay_in_minutes: 1 }] } }) }
        : { haveError: () => false, getBody: () => JSON.stringify({ oncalls: [{ escalation_level: 1, user: { id: 'Z' } }], more: false }) }),
      postREST: (f, body, from) => { calls.push([f, body.requester_id, from, body.responder_request_targets.map((t) => t.responder_request_target.id)]); return { haveError: () => false, getBody: () => '{}' }; }
    });
    const mine = new w.ctx.x_pd_integration.PagerDutyRenotify({
      rest, pd: () => ({ getUserIDFromFieldData: () => 'ME', getUserEmailByPDID: (id) => id + '@mine' }),
      incident: (id) => (id === 'sn-1' ? 'PD-9' : null), defaultUser: 'OTHER'
    });
    mine._now = () => clock;
    mine.start('sn-1', 'X', 'anyone');
    assert.deepStrictEqual(plain(calls), [['incidents/PD-9/responder_requests', 'ME', 'ME@mine', ['Z']]]);
    assert.strictEqual(w.pd.requests.length, 0, 'the world\'s own PagerDuty was not used');
    assert.throws(() => mine.start('unknown', 'X', 'anyone'), /out of context of existing incident/);
  });

  it('with an injected incident lookup, a missing link to PagerDuty is still refused', () => {
    const mine = new w.ctx.x_pd_integration.PagerDutyRenotify({ incident: () => '' });
    assert.throws(() => mine.start('sn-1', 'X', 'snuser'), /not linked to PagerDuty/);
  });

  it('queues the follow-up event through the collaborator it is given, not on the platform', () => {
    const queued = [];
    const mine = new w.ctx.x_pd_integration.PagerDutyRenotify({ queue: (gr) => queued.push(gr.getUniqueValue()) });
    mine._now = () => clock;
    mine.start(w.snIncidentId, 'EP', 'snuser');
    mine.handleReplyEvent(reply('A', 'declined', clock + 1000));
    assert.strictEqual(queued.length, 1);
    assert.strictEqual(w.events.length, 0, 'nothing was queued on the platform');
  });

  it('renotifyUser requests just that responder, as the clicking user, with no run', () => {
    const r = svc.renotifyUser(w.snIncidentId, 'U9', 'snuser');
    assert.strictEqual(r.pdUserId, 'U9');
    assert.deepStrictEqual(plain(w.pd.requests), [{ feature: 'incidents/PINC/responder_requests', users: ['U9'], from: 'req@example.com', requester: 'REQ' }]);
    assert.deepStrictEqual(plain(w.pd.order), ['request:U9']); // no cancel of anything
    assert.strictEqual(w.rowsOf('x_pd_integration_renotify_run').length, 0);
  });

  it('asks the person clicking Renotify on behalf of another user, because PagerDuty ignores a request a person makes of themselves', () => {
    w.pd.oncalls = [oc(1, 'REQ'), oc(1, 'A'), oc(2, 'B')]; // REQ is the clicking user's PagerDuty id
    svc.start(w.snIncidentId, 'EP', 'snuser');
    const posts = plain(w.pd.requests);
    assert.deepStrictEqual(posts.map((p) => [p.users, p.requester, p.from]), [
      [['A'], 'REQ', 'req@example.com'],
      [['REQ'], 'DEFAULT', 'default@example.com']
    ]);
    // the run still waits for both
    assert.deepStrictEqual(Object.keys(JSON.parse(run().run_json).responses).sort(), ['A', 'REQ']);
  });

  it('keeps one request, by the clicking user, when they are not in the level', () => {
    svc.start(w.snIncidentId, 'EP', 'snuser');
    assert.deepStrictEqual(plain(w.pd.requests.map((p) => [p.users, p.requester])), [[['A'], 'REQ']]);
  });

  it('renotifying yourself from the individuals list is also made on behalf of another user', () => {
    svc.renotifyUser(w.snIncidentId, 'REQ', 'snuser');
    assert.deepStrictEqual(plain(w.pd.requests.map((p) => [p.users, p.requester, p.from])), [[['REQ'], 'DEFAULT', 'default@example.com']]);
  });

  it('with no other user to ask on behalf of, still sends the request and carries on', () => {
    delete w.props['x_pd_integration.default_user'];
    w.pd.oncalls = [oc(1, 'REQ'), oc(2, 'B')];
    svc.start(w.snIncidentId, 'EP', 'snuser');
    assert.deepStrictEqual(plain(w.pd.requests.map((p) => [p.users, p.requester])), [[['REQ'], 'REQ']]);
    assert.strictEqual(run().state, 'active');
  });

  it('renotifyUser checks what start checks, and needs a responder', () => {
    assert.throws(() => svc.renotifyUser(w.snIncidentId, 'U9', 'unknown'), /not mapped/);
    assert.throws(() => svc.renotifyUser(w.snIncidentId, '', 'snuser'), /choose a responder/);
    assert.throws(() => svc.renotifyUser('0'.repeat(32), 'U9', 'snuser'), /out of context/);
    assert.strictEqual(w.pd.requests.length, 0);
  });

  it('renotifyUser reports a PagerDuty failure', () => {
    w.pd.postFails = true;
    assert.throws(() => svc.renotifyUser(w.snIncidentId, 'U9', 'snuser'), /Could not request responders/);
  });
});

(available ? describe : describe.skip)('PagerDutyRenotifyController (real Script Include, fake platform)', () => {
  let w, ctl;
  const row = (table, fields) => { const g = new w.ctx.GlideRecord(table); g.initialize(); Object.keys(fields).forEach((k) => g.setValue(k, fields[k])); return g.insert(); };
  const request = (fields) => row('x_pd_integration_pagerduty_response_requests', Object.assign({ incident: w.snIncidentId }, fields));
  beforeEach(() => {
    w = makeWorld();
    w.pd.policy = { id: 'EP', name: 'Test EP', num_loops: 0, escalation_rules: [{ escalation_delay_in_minutes: 1 }] };
    ctl = w.ctx.PagerDutyRenotifyController;
    row('x_pd_integration_escalation_policies', { escalation_policy_id: 'EP1', escalation_policy_name: 'Primary EP' });
  });

  it('lists each responder once, however they were added, with the current state and how they got there', () => {
    request({ pd_user_id: 'UA', pd_group_id: '', state: 'Pending' });               // added on their own
    request({ pd_user_id: 'UB', pd_group_id: 'EP1', state: 'Pending' });             // added through a policy
    request({ pd_user_id: 'UB', pd_group_id: '', state: 'Declined' });               // and later on their own: newest row wins
    const out = plain(ctl.listResponders(w.snIncidentId));
    assert.deepStrictEqual(out.items.map((i) => [i.id, i.state, i.via]), [
      ['UB', 'Declined', 'individually, Primary EP'],
      ['UA', 'Pending', 'individually']
    ]);
  });

  it('lists someone added only through a policy, naming the policy', () => {
    request({ pd_user_id: 'UC', pd_group_id: 'EP1', state: 'Accepted' });
    assert.deepStrictEqual(plain(ctl.listResponders(w.snIncidentId)).items.map((i) => [i.id, i.state, i.via]), [['UC', 'Accepted', 'Primary EP']]);
  });

  it('names people from ServiceNow first, then PagerDuty, then falls back to the id', () => {
    row('sys_user', { name: 'Ada Lovelace', x_pd_integration_pagerduty_id: 'UA' });
    w.pd.users.UB = 'Bob From PagerDuty';
    request({ pd_user_id: 'UA', state: 'Pending' });
    request({ pd_user_id: 'UB', state: 'Pending' });
    request({ pd_user_id: 'UC', state: 'Pending' });
    const names = plain(ctl.listResponders(w.snIncidentId)).items.reduce((m, i) => Object.assign(m, { [i.id]: i.text }), {});
    assert.deepStrictEqual(names, { UA: 'Ada Lovelace', UB: 'Bob From PagerDuty', UC: 'UC' });
  });

  it('prefers the ServiceNow user already linked to the request', () => {
    request({ pd_user_id: 'UA', state: 'Pending', assigned_to: 'u1', assigned_to_name: 'Grace Hopper' });
    assert.strictEqual(plain(ctl.listResponders(w.snIncidentId)).items[0].text, 'Grace Hopper');
  });

  it('only lists this incident\'s responders', () => {
    request({ pd_user_id: 'UA', state: 'Pending' });
    row('x_pd_integration_pagerduty_response_requests', { incident: 'other-incident', pd_user_id: 'UZ', state: 'Pending' });
    assert.deepStrictEqual(plain(ctl.listResponders(w.snIncidentId)).items.map((i) => i.id), ['UA']);
  });

  it('shows a cancelled request as Cancelled, not as the app\'s (unknown)', () => {
    request({ pd_user_id: 'UA', state: '(unknown)' });
    request({ pd_user_id: 'UB', state: 'Declined' });
    const states = plain(ctl.listResponders(w.snIncidentId)).items.reduce((m, i) => Object.assign(m, { [i.id]: i.state }), {});
    assert.deepStrictEqual(states, { UA: 'Cancelled', UB: 'Declined' });
  });

  it('is empty when nobody was added', () => {
    assert.deepStrictEqual(plain(ctl.listResponders(w.snIncidentId)), { items: [] });
  });

  it('keeps listing policies as before, with the policy name and the state of the latest run', () => {
    request({ pd_user_id: 'UB', pd_group_id: 'EP1', state: 'Pending' });
    row('x_pd_integration_renotify_run', { incident: w.snIncidentId, pd_policy_id: 'EP1', state: 'joined', level: 2, active: false });
    assert.deepStrictEqual(plain(ctl.listEscalationPolicies(w.snIncidentId)).items.map((i) => [i.id, i.text, i.runState, i.runActive]), [['EP1', 'Primary EP', 'joined', false]]);
  });

  it('describes a run for the dialog: progress, who it is waiting on, when it started, and why it failed', () => {
    request({ pd_user_id: 'UB', pd_group_id: 'EP1', state: 'Pending' });
    w.pd.users = { UA: 'Ada Lovelace' };
    const saved = { rules: [{ level: 1 }, { level: 2 }, { level: 3 }], numLoops: 2, responses: { UA: 'pending', UB: 'declined' } };
    row('x_pd_integration_renotify_run', { incident: w.snIncidentId, pd_policy_id: 'EP1', state: 'active', level: 2, loop: 1, active: true, run_json: JSON.stringify(saved), last_error: '' });
    const item = plain(ctl.listEscalationPolicies(w.snIncidentId)).items[0];
    assert.deepStrictEqual([item.runLevelCount, item.runNumLoops, item.runLoop], [3, 2, '1']);
    assert.deepStrictEqual(item.runWaiting.map((x) => [x.name, x.state]), [['Ada Lovelace', 'pending'], ['UB', 'declined']]);
    assert.ok(item.runStarted !== undefined && item.runUpdated !== undefined);

    w.rowsOf('x_pd_integration_renotify_run')[0].active = '0';
    w.rowsOf('x_pd_integration_renotify_run')[0].state = 'failed';
    w.rowsOf('x_pd_integration_renotify_run')[0].last_error = 'Could not request responders: HTTP 500';
    const failed = plain(ctl.listEscalationPolicies(w.snIncidentId)).items[0];
    assert.strictEqual(failed.runError, 'Could not request responders: HTTP 500');
    assert.deepStrictEqual(failed.runWaiting, [], 'nobody is waited on once the run is over');
  });

  it('still lists a run whose saved state cannot be read', () => {
    request({ pd_user_id: 'UB', pd_group_id: 'EP1', state: 'Pending' });
    row('x_pd_integration_renotify_run', { incident: w.snIncidentId, pd_policy_id: 'EP1', state: 'joined', level: 1, loop: 0, active: false, run_json: 'not json' });
    const item = plain(ctl.listEscalationPolicies(w.snIncidentId)).items[0];
    assert.strictEqual(item.runState, 'joined');
    assert.strictEqual(item.runLevelCount, 0);
  });

  it('says when each responder was last updated', () => {
    request({ pd_user_id: 'UA', state: 'Pending' });
    assert.ok('updated' in plain(ctl.listResponders(w.snIncidentId)).items[0]);
  });

  it('renotifyUser delegates to the executor and says what it did', () => {
    const out = plain(ctl.renotifyUser({ snIncidentId: w.snIncidentId, pdUserId: 'UA', currentUser: 'snuser' }));
    assert.match(out.message, /Renotification request sent/);
    assert.deepStrictEqual(plain(w.pd.requests.map((r) => r.users)), [['UA']]);
  });
});
