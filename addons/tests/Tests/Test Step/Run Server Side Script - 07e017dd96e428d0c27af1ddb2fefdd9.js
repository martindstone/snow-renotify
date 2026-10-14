(function(outputs, steps, params, stepResult, assertEqual) {
    var exists = function (table, query) {
      var gr = new GlideRecord(table);
      gr.addEncodedQuery(query);
      gr.setLimit(1);
      gr.query();
      return gr.next() ? gr : null;
    };

    describe('Renotify install: the overlay\'s records are in place', function () {
      it('the run table has every column the executor writes', function () {
        var run = new GlideRecord('x_pd_integration_renotify_run');
        expect(run.isValid()).toBe(true);
        ['incident', 'pd_incident_id', 'pd_policy_id', 'policy_name', 'requester_pd_id', 'run_json', 'pending_actions', 'state', 'active', 'level', 'loop', 'last_error'].forEach(function (column) {
          expect(run.isValidField(column)).toBe(true);
        });
      });

      it('the Script Includes can be created', function () {
        expect(typeof new x_pd_integration.PagerDutyRenotifyMachine().start).toBe('function');
        expect(typeof new x_pd_integration.PagerDutyRenotify().start).toBe('function');
      });

      it('webhook replies reach the run: the Business Rule is active on the webhook import table', function () {
        var rule = exists('sys_script', 'name=PD Renotify Escalation Policy on Webhook^collection=x_pd_integration_webhook_import');
        expect(rule).not.toBe(null);
        expect(rule.getValue('active')).toBe('1');
        expect(rule.getValue('when')).toBe('after');
      });

      it('follow-up work runs: the event, its Script Action and the one-minute tick are registered and active', function () {
        expect(exists('sysevent_register', 'event_name=x_pd_integration.renotify_run')).not.toBe(null);
        var action = exists('sysevent_script_action', 'name=PagerDuty Renotify Run^event_name=x_pd_integration.renotify_run');
        expect(action).not.toBe(null);
        expect(action.getValue('active')).toBe('1');
        var job = exists('sysauto_script', 'name=PagerDuty Renotify Tick');
        expect(job).not.toBe(null);
        expect(job.getValue('active')).toBe('1');
        // like the integration's own PagerDuty refresh jobs, it is not tied to a named user (the OOTB admin may be renamed or deactivated)
        expect(job.getValue('run_as')).toBeFalsy();
        expect(job.getValue('run_type')).toBe('periodically');
      });

      it('the button and the dialog exist', function () {
        var button = exists('sys_ui_action', 'name=Renotify^table=incident');
        expect(button).not.toBe(null);
        expect(button.getValue('active')).toBe('1');
        expect(exists('sys_ui_page', 'name=renotify_dialog')).not.toBe(null);
        expect(exists('sys_script_include', 'name=PagerDutyRenotifyController')).not.toBe(null);
      });
    });
})(outputs, steps, params, stepResult, assertEqual);

jasmine.getEnv().execute();
