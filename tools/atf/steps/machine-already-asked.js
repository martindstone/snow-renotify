var kit = new x_pd_integration.PagerDutyRenotifyTestKit();
var policy = function (delays) {
  return { num_loops: 0, escalation_rules: delays.map(function (d) { return { escalation_delay_in_minutes: d }; }) };
};
var two = function () {
  return kit.machine(policy([15, 15]), function (level) { return [kit.oncall(level, level === 1 ? 'A' : 'B')]; });
};

describe('Renotify machine: people PagerDuty already asked', function () {
  it('counts their answer from the moment PagerDuty asked them, not from when the level was requested', function () {
    var r = two().start().at(1).reply('A', 'declined', 1).alreadyAsked({ B: 0.5 });
    r.at(2).reply('B', 'joined', 0.8);
    expect(r.run().state).toBe('joined');
  });

  it('still ignores an answer from before PagerDuty asked them', function () {
    var r = two().start().at(1).reply('A', 'declined', 1).alreadyAsked({ B: 0.5 });
    r.at(2).reply('B', 'joined', 0.2);
    expect(r.run().state).toBe('active');
  });

  it('only knows people of the current level, and leaves the rest on the level\'s own request time', function () {
    var r = kit.machine(policy([15, 15]), function (level) {
      return level === 1 ? [kit.oncall(1, 'A')] : [kit.oncall(2, 'B1'), kit.oncall(2, 'B2')];
    }).start().at(1).reply('A', 'declined', 1).alreadyAsked({ B1: 0.5, ZZ: 0 });
    expect(r.run().askedAt).toEqual({ B1: 0.5 * kit.MINUTE });
    r.at(2).reply('B2', 'joined', 0.8);
    expect(r.run().state).toBe('active');
  });

  it('forgets who was asked when the next level starts', function () {
    var r = kit.machine(policy([15, 15, 15]), function (level) { return [kit.oncall(level, ['A', 'B', 'C'][level - 1])]; })
      .start().at(1).reply('A', 'declined', 1).alreadyAsked({ B: 0.5 });
    expect(r.run().askedAt).toEqual({ B: 0.5 * kit.MINUTE });
    r.at(2).reply('B', 'declined', 2);
    expect(r.run().askedAt).toEqual({});
  });
});
