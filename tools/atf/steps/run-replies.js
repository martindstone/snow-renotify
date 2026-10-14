var kit = new x_pd_integration.PagerDutyRenotifyTestKit();
var world;

describe('Renotify run: replies, timeouts and the end', function () {
  beforeEach(function () { world = kit.world(); });
  afterEach(function () { world.cleanup(); });

  it('a decline queues the follow-up, and running it requests level 2 once', function () {
    world.start();
    world.reply('A', 'declined');
    expect(world.queuedCount()).toBe(1);
    world.flushQueued().flushQueued();
    expect(world.requestedUsers()).toEqual([['A'], ['B']]);
    expect(world.run().getValue('level')).toBe('2');
  });

  it('a duplicate delivery of the same webhook does not request level 2 twice', function () {
    world.start();
    world.reply('A', 'declined').reply('A', 'declined');
    world.flushQueued();
    expect(world.requestedUsers()).toEqual([['A'], ['B']]);
  });

  it('two people on a level replying before the follow-up runs still advance exactly once', function () {
    world.pd.oncalls = [kit.oncall(1, 'A1'), kit.oncall(1, 'A2'), kit.oncall(2, 'B')];
    world.start();
    world.reply('A1', 'declined', 1000).reply('A2', 'declined', 1500);
    world.flushQueued();
    expect(world.requestedUsers()).toEqual([['A1', 'A2'], ['B']]);
  });

  it('a join stops the run and nothing more is ever requested', function () {
    world.start();
    world.reply('A', 'joined');
    expect(world.queuedCount()).toBe(0);
    expect(world.run().getValue('state')).toBe('joined');
    expect(world.run().getValue('active')).toBe('0');
    world.advance(60).tick();
    expect(world.pd.requests.length).toBe(1);
  });

  it('ignores a reply that predates the request it would answer', function () {
    world.start();
    world.advance(1);
    world.reply('A', 'joined', -600000);
    expect(world.run().getValue('state')).toBe('active');
  });

  it('moves to the next level only after the level\'s delay has passed', function () {
    world.start();
    world.advance(14).tick();
    expect(world.pd.requests.length).toBe(1);
    world.advance(1).tick();
    expect(world.requestedUsers()).toEqual([['A'], ['B']]);
  });

  it('resolves the people on call when the level is reached (a shift change)', function () {
    world.start();
    world.pd.oncalls = [kit.oncall(1, 'A'), kit.oncall(2, 'NEW'), kit.oncall(3, 'C')];
    world.advance(15).tick();
    expect(world.requestedUsers()).toEqual([['A'], ['NEW']]);
  });

  it('a run that times out on its last level is saved as exhausted and stops being active', function () {
    world.start();
    world.advance(15).tick();
    world.advance(15).tick();
    world.advance(15).tick();
    expect(world.run().getValue('state')).toBe('exhausted');
    expect(world.run().getValue('active')).toBe('0');
    expect(world.requestedUsers()).toEqual([['A'], ['B'], ['C']]);
    world.advance(60).tick();
    expect(world.pd.requests.length).toBe(3);
  });

  it('repeats the policy for its loops before it is exhausted', function () {
    world = kit.world({ policyDelays: [1, 1], numLoops: 1, oncalls: [kit.oncall(1, 'A'), kit.oncall(2, 'B')] });
    world.start();
    for (var i = 0; i < 3; i++) { world.advance(1).tick(); }
    expect(world.run().getValue('state')).toBe('active');
    expect(world.run().getValue('loop')).toBe('1');
    world.advance(1).tick();
    expect(world.run().getValue('state')).toBe('exhausted');
    expect(world.requestedUsers()).toEqual([['A'], ['B'], ['A'], ['B']]);
  });

  it('a tick that changes nothing does not rewrite the run', function () {
    world.start();
    var before = world.run().getValue('sys_updated_on');
    world.advance(1).tick();
    expect(world.run().getValue('sys_updated_on')).toBe(before);
  });

  it('the incident being resolved ends the run', function () {
    world.start();
    world.resolve();
    expect(world.run().getValue('state')).toBe('resolved');
    expect(world.run().getValue('active')).toBe('0');
    world.advance(60).tick();
    expect(world.pd.requests.length).toBe(1);
  });

  it('purges finished runs after the retention period, never an active run or a young one', function () {
    world.start();
    var days = function (n) { return n * 24 * 60; };
    world.advance(days(40));
    expect(world.svc.purgeFinishedRuns(30, world.pd.incidentId)).toBe(0);   // still active
    expect(world.run().isValidRecord()).toBe(true);
    world.reply('A', 'joined');
    expect(world.svc.purgeFinishedRuns(60, world.pd.incidentId)).toBe(0);   // changed only moments before the fake "now"... but within 60 days
    expect(world.svc.purgeFinishedRuns(0, world.pd.incidentId)).toBe(0);    // 0 keeps everything
    expect(world.run().isValidRecord()).toBe(true);
    expect(world.svc.purgeFinishedRuns(30, world.pd.incidentId)).toBe(1);   // 40 days on, past 30
    expect(world.run().isValidRecord()).toBe(false);
  });

  it('a tick recovers a run left waiting after a follow-up that claimed its work and died', function () {
    world.start();
    world.reply('A', 'declined');
    var stuck = world.run();
    stuck.setValue('pending_actions', '');
    stuck.update();
    world.tick();
    expect(world.requestedUsers()).toEqual([['A'], ['B']]);
  });
});
