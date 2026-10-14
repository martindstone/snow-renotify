var kit = new x_pd_integration.PagerDutyRenotifyTestKit();
var world;
var thrown = function (fn) {
  try { fn(); } catch (e) { return String(e.message || e); }
  return '';
};

describe('Renotify run: failures, stopping and single people', function () {
  beforeEach(function () { world = kit.world(); });
  afterEach(function () { world.cleanup(); });

  it('a PagerDuty failure on start is reported and the run is marked failed', function () {
    world.pd.postFails = true;
    expect(thrown(function () { world.start(); })).not.toBe('');
    var run = world.run();
    expect(run.getValue('state')).toBe('failed');
    expect(run.getValue('active')).toBe('0');
    expect(run.getValue('last_error')).toBeTruthy();
  });

  it('when PagerDuty refuses the on-calls request, the failure points at the oncalls.read OAuth scope', function () {
    world.pd.oncallsStatus = 403;
    expect(thrown(function () { world.start(); })).toContain('oncalls.read');
    expect(world.run().getValue('state')).toBe('failed');
    expect(world.run().getValue('last_error')).toContain('oncalls.read');
    expect(world.pd.requests.length).toBe(0);
  });

  it('other on-calls failures do not mention the scope', function () {
    world.pd.oncallsStatus = 500;
    var message = thrown(function () { world.start(); });
    expect(message).toContain('Could not fetch on-calls');
    expect(message).not.toContain('oncalls.read');
  });

  it('a failure on a later level marks the run failed and stops it', function () {
    world.start();
    world.pd.postFails = true;
    world.reply('A', 'declined');
    world.flushQueued();
    expect(world.run().getValue('state')).toBe('failed');
    world.pd.postFails = false;
    world.advance(60).tick();
    expect(world.pd.requests.length).toBe(1);
  });

  it('cancel stops an active run and nothing more is requested', function () {
    world.start();
    var id = world.run().getUniqueValue();
    world.svc.cancel(id);
    expect(world.run().getValue('state')).toBe('cancelled');
    expect(world.run().getValue('active')).toBe('0');
    world.advance(60).tick();
    expect(world.pd.requests.length).toBe(1);
  });

  it('cancel of a run that has already ended changes nothing', function () {
    world.start();
    world.reply('A', 'joined');
    world.svc.cancel(world.run().getUniqueValue());
    expect(world.run().getValue('state')).toBe('joined');
  });

  it('renotifying one person requests just them, as the user who clicked, and starts no run', function () {
    world.svc.renotifyUser(world.SN_INCIDENT, 'U9', world.SN_USER);
    expect(world.pd.requests).toEqual([{ users: ['U9'], requester: 'REQ', from: 'req@example.com' }]);
    expect(world.run().isValidRecord()).toBe(false);
  });

  it('renotifying yourself is requested on behalf of another user, because PagerDuty ignores a request you make of yourself', function () {
    world.svc.renotifyUser(world.SN_INCIDENT, 'REQ', world.SN_USER);
    expect(world.pd.requests).toEqual([{ users: ['REQ'], requester: 'DEFAULT', from: 'default@example.com' }]);
  });

  it('renotifying one person needs a person, and checks what start checks', function () {
    expect(thrown(function () { world.svc.renotifyUser(world.SN_INCIDENT, '', world.SN_USER); })).toContain('choose a responder');
    expect(thrown(function () { world.svc.renotifyUser('no-such-incident', 'U9', world.SN_USER); })).toContain('out of context');
    expect(thrown(function () { world.svc.renotifyUser(world.SN_INCIDENT, 'U9', 'nobody'); })).toContain('not mapped');
  });

  it('renotifying one person reports a PagerDuty failure', function () {
    world.pd.postFails = true;
    expect(thrown(function () { world.svc.renotifyUser(world.SN_INCIDENT, 'U9', world.SN_USER); })).not.toBe('');
  });
});
