(function(outputs, steps, params, stepResult, assertEqual) {
    var kit = new x_pd_integration.PagerDutyRenotifyTestKit();
    var policy = function (delays, numLoops) {
      return { num_loops: numLoops || 0, escalation_rules: delays.map(function (d) { return { escalation_delay_in_minutes: d }; }) };
    };
    var abc = function () {
      return kit.machine(policy([15, 15, 15], 3), function () { return [kit.oncall(1, 'A'), kit.oncall(2, 'B'), kit.oncall(3, 'C')]; });
    };

    describe('Renotify machine: timeouts, loops and the end', function () {
      it('moves on only after the level delay', function () {
        var r = abc().start().at(14).tick();
        expect(r.requests.length).toBe(1);
        r.at(15).tick();
        expect(r.requests[1]).toEqual({ atMin: 15, userIds: ['B'] });
      });

      it('repeats the levels for the policy\'s loops and then is exhausted: 3 levels x (1 + 3 loops) = 12 requests', function () {
        var r = abc().start();
        for (var m = 15; m <= 15 * 12; m += 15) { r.at(m).tick(); }
        expect(r.requests.length).toBe(12);
        expect(r.run().state).toBe('exhausted');
        expect(r.run().loop).toBe(3);
        expect(r.requests[3].userIds).toEqual(['A']);
      });

      it('a policy with no rules is exhausted at once', function () {
        var r = kit.machine(policy([]), function () { return []; }).start();
        expect(r.run().state).toBe('exhausted');
      });

      it('resolves the people on call when each level is reached, so a shift change counts', function () {
        var onCall = 'A';
        var r = kit.machine(policy([10, 10]), function (level) { return [kit.oncall(level, level === 1 ? 'A' : onCall)]; }).start();
        onCall = 'NEW';
        r.at(10).tick();
        expect(r.users()).toEqual([['A'], ['NEW']]);
      });

      it('skips a level with nobody on call', function () {
        var r = kit.machine(policy([10, 10, 10]), function (level) { return level === 2 ? [] : [kit.oncall(level, 'U' + level)]; }).start();
        r.at(10).tick();
        expect(r.requests).toEqual([{ atMin: 0, userIds: ['U1'] }, { atMin: 10, userIds: ['U3'] }]);
      });

      it('stops when the incident is resolved', function () {
        var r = abc().start().resolveIncident();
        expect(r.run().state).toBe('resolved');
        r.at(99).tick();
        expect(r.requests.length).toBe(1);
      });

      it('counts a level as due when its delay expired, not when the timer noticed', function () {
        var r = abc().start().at(20).tick();
        expect(r.run().resolveStartedAt).toBe(15 * kit.MINUTE);
        var second = abc().start().at(15).tick().at(40).tick();
        expect(second.run().resolveStartedAt).toBe(30 * kit.MINUTE);
      });

      it('counts a level as due when PagerDuty stamped the decline, unless that is missing or in the future', function () {
        expect(abc().start().at(5).reply('A', 'declined', 2).run().resolveStartedAt).toBe(2 * kit.MINUTE);
        expect(abc().start().at(5).reply('A', 'declined').run().resolveStartedAt).toBe(5 * kit.MINUTE);
        expect(abc().start().at(5).reply('A', 'declined', 9).run().resolveStartedAt).toBe(5 * kit.MINUTE);
      });
    });
})(outputs, steps, params, stepResult, assertEqual);

jasmine.getEnv().execute();
