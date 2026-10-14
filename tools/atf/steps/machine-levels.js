var kit = new x_pd_integration.PagerDutyRenotifyTestKit();
var policy = function (delays, numLoops) {
  return { num_loops: numLoops || 0, escalation_rules: delays.map(function (d) { return { escalation_delay_in_minutes: d }; }) };
};
var abc = function () {
  return kit.machine(policy([15, 15, 15], 3), function () { return [kit.oncall(1, 'A'), kit.oncall(2, 'B'), kit.oncall(3, 'C')]; });
};

describe('Renotify machine: levels, joins and declines', function () {
  it('starts at level 1 and requests only that level', function () {
    var r = abc().start();
    expect(r.requests).toEqual([{ atMin: 0, userIds: ['A'] }]);
    expect(r.run().phase).toBe('waiting');
  });

  it('a join stops the run and requests nothing else, however long it waits', function () {
    var r = abc().start().at(3).reply('A', 'joined');
    expect(r.run().state).toBe('joined');
    r.at(99).tick();
    expect(r.users()).toEqual([['A']]);
  });

  it('a decline requests the next level immediately', function () {
    var r = abc().start().at(2).reply('A', 'declined');
    expect(r.requests[1]).toEqual({ atMin: 2, userIds: ['B'] });
  });

  it('a cancelled request counts as a decline', function () {
    var r = abc().start().at(1).reply('A', 'user_cancelled');
    expect(r.requests[1].userIds).toEqual(['B']);
  });

  it('a level with two people waits until both decline, and stops when either joins', function () {
    var twoOnFirst = function () {
      return kit.machine(policy([10, 10]), function (level) { return level === 1 ? [kit.oncall(1, 'A1'), kit.oncall(1, 'A2')] : [kit.oncall(2, 'B')]; }).start();
    };
    var declined = twoOnFirst().at(1).reply('A1', 'declined');
    expect(declined.requests.length).toBe(1);
    declined.at(2).reply('A2', 'declined');
    expect(declined.requests[1].userIds).toEqual(['B']);

    var joined = twoOnFirst().at(1).reply('A1', 'declined').at(2).reply('A2', 'joined');
    expect(joined.run().state).toBe('joined');
    expect(joined.requests.length).toBe(1);
  });

  it('ignores a reply from someone who is not on the current level', function () {
    var r = abc().start().at(15).tick().at(16).reply('A', 'joined');
    expect(r.run().state).toBe('active');
  });

  it('ignores a reply that predates the request it would answer', function () {
    var r = abc().start().at(15).tick();
    r.at(16).reply('B', 'joined', 5);
    expect(r.run().state).toBe('active');
    r.at(17).reply('B', 'joined', 16);
    expect(r.run().state).toBe('joined');
  });

  it('starts over whatever happened before: asks A, then B, then C even though A had declined earlier', function () {
    var r = abc().start().at(4).reply('A', 'declined').at(19).tick();
    expect(r.users()).toEqual([['A'], ['B'], ['C']]);
  });
});
