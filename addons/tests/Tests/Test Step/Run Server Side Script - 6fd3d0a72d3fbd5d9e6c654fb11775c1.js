(function(outputs, steps, params, stepResult, assertEqual) {
    var kit = new x_pd_integration.PagerDutyRenotifyTestKit();
    var world;
    var thrown = function (fn) {
      try { fn(); } catch (e) { return String(e.message || e); }
      return '';
    };

    describe('Renotify run: start', function () {
      beforeEach(function () { world = kit.world(); });
      afterEach(function () { world.cleanup(); });

      it('requests only level 1, as the user who clicked, and records an active run', function () {
        var started = world.start();
        expect(started.policyName).toBe('ATF policy');
        expect(world.pd.requests.length).toBe(1);
        expect(world.pd.requests[0].users).toEqual(['A']);
        expect(world.pd.requests[0].requester).toBe('REQ');
        expect(world.pd.requests[0].from).toBe('req@example.com');
        var run = world.run();
        expect(run.getValue('state')).toBe('active');
        expect(run.getValue('active')).toBe('1');
        expect(run.getValue('level')).toBe('1');
        expect(run.getValue('loop')).toBe('0');
        expect(run.getValue('policy_name')).toBe('ATF policy');
        expect(run.getValue('pd_policy_id')).toBe(world.pd.policy.id);
        expect(run.getValue('pd_incident_id')).toBe(world.pd.incidentId);
        expect(run.getValue('requester_pd_id')).toBe('REQ');
        expect(run.getValue('pending_actions')).toBeFalsy();
      });

      it('keeps everything it needs to continue in the run', function () {
        world.start();
        var saved = JSON.parse(world.run().getValue('run_json'));
        expect(saved.rules.length).toBe(3);
        expect(saved.policyId).toBe(world.pd.policy.id);
        expect(saved.phase).toBe('waiting');
      });

      it('asks PagerDuty for on-calls with a query the platform accepts, and only for this policy', function () {
        world.pd.oncalls = [kit.oncall(1, 'A')];
        world.start();
        expect(world.run().getValue('state')).toBe('active');
        expect(world.requestedUsers()).toEqual([['A']]);
      });

      it('refuses a second run for the same incident and policy while one is active', function () {
        world.start();
        expect(thrown(function () { world.start(); })).toContain('already being renotified');
        expect(world.pd.requests.length).toBe(1);
      });

      it('rejects a user with no PagerDuty mapping before anything is sent', function () {
        var message = thrown(function () { world.svc.start(world.SN_INCIDENT, world.pd.policy.id, 'nobody'); });
        expect(message).toContain('not mapped');
        expect(world.pd.requests.length).toBe(0);
      });

      it('rejects an incident that does not exist, or is not linked to PagerDuty', function () {
        expect(thrown(function () { world.svc.start('no-such-incident', world.pd.policy.id, world.SN_USER); })).toContain('out of context');
        var unlinked = new x_pd_integration.PagerDutyRenotify({ incident: function () { return ''; } });
        expect(thrown(function () { unlinked.start('x', world.pd.policy.id, world.SN_USER); })).toContain('not linked to PagerDuty');
      });

      it('puts the person clicking on level 1 into a separate request made on behalf of another user', function () {
        world.pd.oncalls = [kit.oncall(1, 'REQ'), kit.oncall(1, 'A'), kit.oncall(2, 'B')];
        world.start();
        expect(world.pd.requests.length).toBe(2);
        expect(world.pd.requests[0]).toEqual({ users: ['A'], requester: 'REQ', from: 'req@example.com' });
        expect(world.pd.requests[1]).toEqual({ users: ['REQ'], requester: 'DEFAULT', from: 'default@example.com' });
      });

      it('with no other user to ask on behalf of, still sends the request and carries on', function () {
        world = kit.world({ defaultUser: '' });
        world.pd.oncalls = [kit.oncall(1, 'REQ'), kit.oncall(2, 'B')];
        world.start();
        expect(world.pd.requests.length).toBe(1);
        expect(world.run().getValue('state')).toBe('active');
      });
    });
})(outputs, steps, params, stepResult, assertEqual);

jasmine.getEnv().execute();
