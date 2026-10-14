var kit = new x_pd_integration.PagerDutyRenotifyTestKit();
var world;

// Someone PagerDuty has asked itself, as GET /incidents/{id} reports them
var asked = function (userId, atMs, state) {
  return { user: { id: userId }, state: state || 'pending', requested_at: new Date(atMs).toISOString() };
};

describe('Renotify run: people PagerDuty already asked', function () {
  beforeEach(function () { world = kit.world(); });
  afterEach(function () { world.cleanup(); });

  it('does not ask again someone PagerDuty asked itself just as the level became due, but still waits for their answer', function () {
    world.start();
    var declinedAt = world.now() + 1000;
    world.pd.incidentResponders = [asked('B', declinedAt)];
    world.advance(0.2);
    world.svc.handleReplyEvent(kit.replyEvent(world.pd.incidentId, 'A', 'declined', declinedAt));
    world.flushQueued();
    expect(world.requestedUsers()).toEqual([['A']]);
    expect(world.run().getValue('level')).toBe('2');
    world.svc.handleReplyEvent(kit.replyEvent(world.pd.incidentId, 'B', 'joined', declinedAt + 5000));
    expect(world.run().getValue('state')).toBe('joined');
  });

  it('asks someone whose pending request is older than the moment the level became due', function () {
    world.start();
    world.pd.incidentResponders = [asked('B', world.now() - 600000)];
    world.reply('A', 'declined');
    world.flushQueued();
    expect(world.requestedUsers()).toEqual([['A'], ['B']]);
  });

  it('asks again someone PagerDuty asked before the click: that is what Renotify is for', function () {
    world.pd.incidentResponders = [asked('A', world.now() - 30000)];
    world.start();
    expect(world.requestedUsers()).toEqual([['A']]);
  });

  it('skips only the people already asked in a level with several', function () {
    world.pd.oncalls = [kit.oncall(1, 'A'), kit.oncall(2, 'B1'), kit.oncall(2, 'B2')];
    world.start();
    world.pd.incidentResponders = [asked('B1', world.now() + 1000)];
    world.reply('A', 'declined');
    world.flushQueued();
    expect(world.requestedUsers()).toEqual([['A'], ['B2']]);
    expect(Object.keys(JSON.parse(world.run().getValue('run_json')).responses).sort()).toEqual(['B1', 'B2']);
  });

  it('asks someone who has already answered', function () {
    world.start();
    world.pd.incidentResponders = [asked('B', world.now() + 1000, 'declined')];
    world.reply('A', 'declined');
    world.flushQueued();
    expect(world.requestedUsers()).toEqual([['A'], ['B']]);
  });

  it('uses the moment the delay expired, not when the timer noticed, when a level times out', function () {
    world.start();
    world.advance(16);
    world.pd.incidentResponders = [asked('B', world.now() - 60000 + 500)];
    world.tick();
    expect(world.requestedUsers()).toEqual([['A']]);
  });

  it('asks everyone when PagerDuty cannot be read', function () {
    world.start();
    world.pd.incidentFails = true;
    world.pd.incidentResponders = [asked('B', world.now() + 1000)];
    world.reply('A', 'declined');
    world.flushQueued();
    expect(world.requestedUsers()).toEqual([['A'], ['B']]);
  });

  it('never skips the one-off renotify of a person', function () {
    world.pd.incidentResponders = [asked('U9', world.now() + 1000)];
    world.svc.renotifyUser(world.SN_INCIDENT, 'U9', world.SN_USER);
    expect(world.requestedUsers()).toEqual([['U9']]);
  });
});
