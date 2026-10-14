const assert = require('assert');
const R = require('../lib/renotify');

const MIN = 60000;
const policy = (delays, numLoops) => ({
  num_loops: numLoops || 0,
  escalation_rules: delays.map((d) => ({ escalation_delay_in_minutes: d }))
});
const oc = (level, ...ids) => ids.map((id) => ({ escalation_level: level, user: { id } }));

// Plays the executor: resolves each level from oncallsFor(level) at the moment the level is reached,
// records the requestResponders actions, and exposes the clock in minutes.
function runner(pol, oncallsFor) {
  const { rules, numLoops } = R.buildRules(pol);
  const requests = [];
  let t = 0;
  let run;
  const exec = (actions) => {
    actions.forEach((a) => {
      if (a.type === 'requestResponders') requests.push({ atMin: t / MIN, userIds: a.userIds });
      if (a.type === 'resolveLevel') exec(R.onLevelResolved(run, R.usersForLevel(oncallsFor(a.level), a.level), t).actions);
    });
  };
  const api = {
    requests,
    get run() { return run; },
    start() { const s = R.start({ incidentId: 'I', policyId: 'P', requesterId: 'R', rules, numLoops }, t); run = s.run; exec(s.actions); return api; },
    at(minutes) { t = minutes * MIN; return api; },
    reply(user, status, repliedAtMin) {
      exec(R.onReply(run, user, status, t, repliedAtMin === undefined ? undefined : repliedAtMin * MIN).actions);
      return api;
    },
    tick() { exec(R.onTick(run, t).actions); return api; },
    users() { return requests.map((x) => x.userIds); }
  };
  return api;
}

describe('buildRules / usersForLevel', () => {
  it('numbers rules by position and reads num_loops', () => {
    assert.deepStrictEqual(R.buildRules(policy([10, 5], 2)), {
      rules: [{ level: 1, delayMinutes: 10 }, { level: 2, delayMinutes: 5 }],
      numLoops: 2
    });
  });

  it('returns distinct users for one level, skipping empty slots', () => {
    const calls = [...oc(1, 'U1', 'U2', 'U1'), { escalation_level: 1, user: null }, ...oc(2, 'U3')];
    assert.deepStrictEqual(R.usersForLevel(calls, 1), ['U1', 'U2']);
    assert.deepStrictEqual(R.usersForLevel(calls, 2), ['U3']);
    assert.deepStrictEqual(R.usersForLevel(calls, 3), []);
  });
});

describe('renotify EP (mirrors adding the EP for the first time)', () => {
  const abc = () => runner(policy([15, 15, 15], 3), () => [...oc(1, 'A'), ...oc(2, 'B'), ...oc(3, 'C')]);

  it('starts at level 1 and requests only that level', () => {
    const r = abc().start();
    assert.deepStrictEqual(r.requests, [{ atMin: 0, userIds: ['A'] }]);
    assert.strictEqual(r.run.phase, 'waiting');
  });

  it('A joins: stops, requests nothing else and has no cancel action', () => {
    const r = abc().start().at(3).reply('A', 'joined');
    assert.strictEqual(r.run.state, 'joined');
    r.at(99).tick();
    assert.deepStrictEqual(r.users(), [['A']]);
  });

  it('A declines: B is requested immediately', () => {
    const r = abc().start().at(2).reply('A', 'declined');
    assert.deepStrictEqual(r.requests[1], { atMin: 2, userIds: ['B'] });
  });

  it('A silent for 15 minutes: B is requested; not before', () => {
    const r = abc().start().at(14).tick();
    assert.strictEqual(r.requests.length, 1);
    r.at(15).tick();
    assert.deepStrictEqual(r.requests[1], { atMin: 15, userIds: ['B'] });
  });

  it('A declined and B joined earlier: the run still asks A, then B again, then C', () => {
    const r = abc().start().at(4).reply('A', 'declined').at(19).tick();
    assert.deepStrictEqual(r.users(), [['A'], ['B'], ['C']]);
  });

  it('exhausts after the last level and all loops: 3 levels x (1 + 3 loops) = 12 requests', () => {
    const r = abc().start();
    for (let m = 15; m <= 15 * 12; m += 15) r.at(m).tick();
    assert.strictEqual(r.requests.length, 12);
    assert.strictEqual(r.run.state, 'exhausted');
    assert.strictEqual(r.run.loop, 3);
  });

  it('re-requests the same users on each loop', () => {
    const r = abc().start().at(15).tick().at(30).tick().at(45).tick();
    assert.deepStrictEqual(r.requests[3].userIds, ['A']);
  });

  it('resolves on-calls when each level is reached (shift change mid-run)', () => {
    let onCall = 'A';
    const r = runner(policy([10, 10]), (lvl) => oc(lvl, lvl === 1 ? 'A' : onCall)).start();
    onCall = 'NEW'; // level 2's shift changes while level 1 is waiting
    r.at(10).tick();
    assert.deepStrictEqual(r.users(), [['A'], ['NEW']]);
  });

  it('skips a level with nobody on call immediately', () => {
    const r = runner(policy([10, 10, 10]), (lvl) => (lvl === 2 ? [] : oc(lvl, 'U' + lvl))).start();
    r.at(10).tick();
    assert.deepStrictEqual(r.requests, [{ atMin: 0, userIds: ['U1'] }, { atMin: 10, userIds: ['U3'] }]);
  });

  it('a level with two users waits until both decline', () => {
    const r = runner(policy([10, 10]), (lvl) => (lvl === 1 ? oc(1, 'A1', 'A2') : oc(2, 'B'))).start();
    r.at(1).reply('A1', 'declined');
    assert.strictEqual(r.requests.length, 1);
    r.at(2).reply('A2', 'declined');
    assert.deepStrictEqual(r.requests[1].userIds, ['B']);
  });

  it('a level with two users stops when either joins', () => {
    const r = runner(policy([10, 10]), (lvl) => (lvl === 1 ? oc(1, 'A1', 'A2') : oc(2, 'B'))).start();
    r.at(1).reply('A1', 'declined').at(2).reply('A2', 'joined');
    assert.strictEqual(r.run.state, 'joined');
    assert.strictEqual(r.requests.length, 1);
  });

  it('treats user_cancelled like a decline', () => {
    const r = abc().start().at(1).reply('A', 'user_cancelled');
    assert.deepStrictEqual(r.requests[1].userIds, ['B']);
  });

  it('ignores a stale reply from before the level was requested', () => {
    const r = abc().start().at(15).tick(); // B requested at minute 15
    r.at(16).reply('B', 'joined', 5); // event time predates B's request
    assert.strictEqual(r.run.state, 'active');
    r.at(17).reply('B', 'joined', 16);
    assert.strictEqual(r.run.state, 'joined');
  });

  it('ignores replies from users not on the current level (A after moving to B)', () => {
    const r = abc().start().at(15).tick().at(16).reply('A', 'joined');
    assert.strictEqual(r.run.state, 'active');
  });

  it('stops when the incident resolves', () => {
    const r = abc().start();
    R.onIncidentStatus(r.run, 'resolved');
    assert.strictEqual(r.run.state, 'resolved');
    r.at(99).tick();
    assert.strictEqual(r.requests.length, 1);
  });

  it('only stops on acknowledge when asked', () => {
    const r = abc().start();
    R.onIncidentStatus(r.run, 'acknowledged', false);
    assert.strictEqual(r.run.state, 'active');
    R.onIncidentStatus(r.run, 'acknowledged', true);
    assert.strictEqual(r.run.state, 'resolved');
  });

  it('an EP with no rules is immediately exhausted', () => {
    const r = runner(policy([]), () => []).start();
    assert.strictEqual(r.run.state, 'exhausted');
  });
});

describe('when a level became due (resolveStartedAt)', () => {
  const abc = () => runner(policy([15, 15, 15], 3), () => [...oc(1, 'A'), ...oc(2, 'B'), ...oc(3, 'C')]);

  it('is the start time for the first level', () => {
    assert.strictEqual(abc().at(7).start().run.resolveStartedAt, 7 * MIN);
  });

  it('after a decline is the time PagerDuty stamped the decline, not when it was processed', () => {
    const r = abc().start().at(5).reply('A', 'declined', 2);
    assert.strictEqual(r.run.resolveStartedAt, 2 * MIN);
  });

  it('after a decline with no usable event time, or one in the future, is now', () => {
    assert.strictEqual(abc().start().at(5).reply('A', 'declined').run.resolveStartedAt, 5 * MIN);
    assert.strictEqual(abc().start().at(5).reply('A', 'declined', 9).run.resolveStartedAt, 5 * MIN);
  });

  it('after a timeout is the moment the delay expired, not when the timer noticed', () => {
    const r = abc().start().at(20).tick();
    assert.strictEqual(r.run.resolveStartedAt, 15 * MIN);
  });

  it('for the second level follows the second level\'s own delay', () => {
    const r = abc().start().at(15).tick().at(40).tick();
    assert.strictEqual(r.run.resolveStartedAt, 30 * MIN); // level 2 was requested at minute 15, due again at 30
  });

  it('after skipping a level with nobody on call is now', () => {
    const r = runner(policy([10, 10, 10]), (lvl) => (lvl === 2 ? [] : oc(lvl, 'U' + lvl))).start().at(10).tick();
    assert.strictEqual(r.run.resolveStartedAt, 10 * MIN);
  });
});

describe('people PagerDuty already asked (onAlreadyAsked)', () => {
  const two = () => runner(policy([15, 15]), (lvl) => oc(lvl, lvl === 1 ? 'A' : 'B'));

  it('counts their answer from the moment PagerDuty asked them, not from when this level was requested', () => {
    const r = two().start().at(1).reply('A', 'declined', 1); // level 2 requested at minute 1
    R.onAlreadyAsked(r.run, { B: 0.5 * MIN }); // PagerDuty had asked B half a minute into the run
    r.at(2).reply('B', 'joined', 0.8);          // B answered at 0.8, before ServiceNow requested the level
    assert.strictEqual(r.run.state, 'joined');
  });

  it('still ignores an answer from before PagerDuty asked them', () => {
    const r = two().start().at(1).reply('A', 'declined', 1);
    R.onAlreadyAsked(r.run, { B: 0.5 * MIN });
    r.at(2).reply('B', 'joined', 0.2);
    assert.strictEqual(r.run.state, 'active');
  });

  it('leaves everyone else on the level\'s own request time, and only knows people of the current level', () => {
    const r = runner(policy([15, 15]), (lvl) => (lvl === 1 ? oc(1, 'A') : [...oc(2, 'B1'), ...oc(2, 'B2')])).start().at(1).reply('A', 'declined', 1);
    R.onAlreadyAsked(r.run, { B1: 0.5 * MIN, ZZ: 0 });
    assert.deepStrictEqual(r.run.askedAt, { B1: 0.5 * MIN });
    r.at(2).reply('B2', 'joined', 0.8); // B2 was asked by ServiceNow at minute 1
    assert.strictEqual(r.run.state, 'active');
  });

  it('forgets who was asked when the next level starts', () => {
    const r = runner(policy([15, 15, 15]), (lvl) => oc(lvl, ['A', 'B', 'C'][lvl - 1])).start().at(1).reply('A', 'declined', 1);
    R.onAlreadyAsked(r.run, { B: 0.5 * MIN });
    assert.deepStrictEqual(r.run.askedAt, { B: 0.5 * MIN });
    r.at(2).reply('B', 'declined', 2); // level 3 starts
    assert.deepStrictEqual(r.run.askedAt, {});
  });
});
