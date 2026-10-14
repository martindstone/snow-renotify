/*** Changes made to this script are not supported by PagerDuty ***/
/**
 * Helpers for the "PD: Renotify ..." ATF tests (the optional tests package of the Renotify overlay).
 *
 * world() builds a PagerDutyRenotify wired to a fake PagerDuty and a fake clock, so a test can drive a whole run - replies,
 * timeouts, loops - in a few lines without PagerDuty, the network or waiting. Runs are real rows of
 * x_pd_integration_renotify_run, so the table, the columns and the JSON the run is saved as are tested too. Everything a world
 * created is removed by cleanup().
 *
 * machine() plays the executor over the pure state machine only (PagerDutyRenotifyMachine), without any record.
 */
var PagerDutyRenotifyTestKit = Class.create();
PagerDutyRenotifyTestKit.prototype = {
  type: 'PagerDutyRenotifyTestKit',

  MINUTE: 60000,
  TABLE: 'x_pd_integration_renotify_run',

  initialize: function () {},

  /** An on-call entry like PagerDuty's GET /oncalls returns it. */
  oncall: function (level, userId) {
    return { escalation_level: level, user: { id: userId } };
  },

  /** An incident.responder.replied v3 webhook payload. */
  replyEvent: function (pdIncidentId, userId, state, occurredAtMs) {
    return {
      event_type: 'incident.responder.replied',
      occurred_at: new Date(occurredAtMs).toISOString(),
      data: { type: 'incident_responder', incident: { id: pdIncidentId }, user: { id: userId }, state: state }
    };
  },

  /** An incident.resolved v3 webhook payload. */
  resolvedEvent: function (pdIncidentId) {
    return { event_type: 'incident.resolved', data: { id: pdIncidentId } };
  },

  /**
   * Plays the executor over the pure state machine: resolves each level when it is reached, records the responder
   * requests, and keeps its own clock in minutes.
   * @param {Object} policy PagerDuty escalation policy ({ num_loops, escalation_rules: [{ escalation_delay_in_minutes }] })
   * @param {Function} oncallsFor function (level) returning the on-calls at that moment
   */
  machine: function (policy, oncallsFor) {
    var machine = new x_pd_integration.PagerDutyRenotifyMachine();
    var built = machine.buildRules(policy);
    var minute = this.MINUTE;
    var requests = [];
    var now = 0;
    var run;
    var api = {};
    var execute = function (actions) {
      actions.forEach(function (action) {
        if (action.type === 'requestResponders') {
          requests.push({ atMin: now / minute, userIds: action.userIds });
        } else if (action.type === 'resolveLevel') {
          execute(machine.onLevelResolved(run, machine.usersForLevel(oncallsFor(action.level), action.level), now).actions);
        }
      });
    };
    api.requests = requests;
    api.run = function () { return run; };
    api.start = function () {
      var started = machine.start({ incidentId: 'I', policyId: 'P', requesterId: 'R', rules: built.rules, numLoops: built.numLoops }, now);
      run = started.run;
      execute(started.actions);
      return api;
    };
    api.at = function (minutes) { now = minutes * minute; return api; };
    api.reply = function (userId, status, repliedAtMin) {
      execute(machine.onReply(run, userId, status, now, repliedAtMin === undefined ? undefined : repliedAtMin * minute).actions);
      return api;
    };
    api.tick = function () { execute(machine.onTick(run, now).actions); return api; };
    api.alreadyAsked = function (askedAtMinByUser) {
      var asked = {};
      Object.keys(askedAtMinByUser).forEach(function (id) { asked[id] = askedAtMinByUser[id] * minute; });
      machine.onAlreadyAsked(run, asked);
      return api;
    };
    api.resolveIncident = function () { machine.onIncidentStatus(run, 'resolved'); return api; };
    api.users = function () { return requests.map(function (r) { return r.userIds; }); };
    return api;
  },

  /**
   * A PagerDutyRenotify on a fake PagerDuty with a fake clock.
   * @param {Object} [options] policyDelays (minutes per level, default [15, 15, 15]), numLoops, oncalls (default A, B, C on
   *   levels 1-3), requester (the PagerDuty user clicking Renotify), defaultUser (the user asked on behalf of that person)
   */
  world: function (options) {
    var kit = this;
    var opts = options || {};
    var id = 'ATF' + new Date().getTime() + Math.floor(Math.random() * 100000);
    var delays = opts.policyDelays || [15, 15, 15];
    var createdRuns = [];

    var pd = {
      incidentId: id + 'I',
      policy: {
        id: id + 'P',
        name: 'ATF policy',
        num_loops: opts.numLoops || 0,
        escalation_rules: delays.map(function (d) { return { escalation_delay_in_minutes: d }; })
      },
      oncalls: opts.oncalls || [kit.oncall(1, 'A'), kit.oncall(2, 'B'), kit.oncall(3, 'C')],
      incidentResponders: [], // as GET /incidents/{id} reports them: { user: { id }, state, requested_at }
      requests: [],           // what was asked of PagerDuty: { users, requester, from }
      postFails: false,
      oncallsStatus: 0,       // set to an HTTP status to make the on-calls request fail with it
      incidentFails: false
    };

    var response = function (status, body) {
      return { getStatusCode: function () { return status; }, haveError: function () { return status >= 400; }, getErrorMessage: function () { return 'HTTP ' + status; }, getBody: function () { return JSON.stringify(body); } };
    };
    var FakeRest = function () {};
    FakeRest.prototype = {
      hasError: function () { return false; },
      getError: function () { return ''; },
      getREST: function (feature) {
        // Like the platform's REST client, a raw '[' or ']' is "Invalid query"
        if (/[\[\]]/.test(feature)) { return response(400, { error: 'Invalid query' }); }
        var route = feature.split('?')[0];
        if (route === 'escalation_policies/' + pd.policy.id) { return response(200, { escalation_policy: pd.policy }); }
        if (route === 'incidents/' + pd.incidentId) {
          if (pd.incidentFails) { return response(500, { error: 'boom' }); }
          return response(200, { incident: { id: pd.incidentId, incidents_responders: pd.incidentResponders } });
        }
        if (route === 'oncalls') {
          if (pd.oncallsStatus) { return response(pd.oncallsStatus, { error: 'refused' }); }
          return feature.indexOf('escalation_policy_ids%5B%5D=' + pd.policy.id) >= 0
            ? response(200, { oncalls: pd.oncalls, more: false })
            : response(200, { oncalls: [], more: false });
        }
        return response(404, {});
      },
      postREST: function (feature, body, from) {
        if (pd.postFails) { return response(500, { error: 'boom' }); }
        pd.requests.push({
          users: body.responder_request_targets.map(function (t) { return t.responder_request_target.id; }),
          requester: body.requester_id,
          from: from
        });
        return response(200, {});
      }
    };

    var requester = opts.requester || 'REQ';
    var queued = [];
    var clock = new Date().getTime();
    var svc = new x_pd_integration.PagerDutyRenotify({
      rest: function () { return new FakeRest(); },
      pd: function () {
        return {
          getUserIDFromFieldData: function (snUserId) { return snUserId === 'atf-user' ? requester : null; },
          getUserEmailByPDID: function (pdUserId) { return pdUserId.toLowerCase() + '@example.com'; }
        };
      },
      defaultUser: opts.defaultUser !== undefined ? opts.defaultUser : 'DEFAULT',
      incident: function (snIncidentSysId) { return snIncidentSysId === 'atf-incident' ? pd.incidentId : null; },
      queue: function (runRecord) { queued.push(runRecord.getUniqueValue()); }
    });
    svc._now = function () { return clock; };

    var world = { pd: pd, svc: svc, SN_INCIDENT: 'atf-incident', SN_USER: 'atf-user', requester: requester };
    world.now = function () { return clock; };
    world.advance = function (minutes) { clock += minutes * kit.MINUTE; return world; };
    world.start = function () {
      var started = svc.start(world.SN_INCIDENT, pd.policy.id, world.SN_USER);
      createdRuns.push(started.runId);
      return started;
    };
    world.reply = function (userId, state, offsetMs) {
      svc.handleReplyEvent(kit.replyEvent(pd.incidentId, userId, state, clock + (offsetMs === undefined ? 1000 : offsetMs)));
      return world;
    };
    world.resolve = function () { svc.handleResolvedEvent(kit.resolvedEvent(pd.incidentId)); return world; };
    world.tick = function () { svc.tick(pd.incidentId); return world; };
    /** Runs the work the executor queued as events (what the Script Action does). */
    world.flushQueued = function () {
      while (queued.length) { svc.flush(queued.shift()); }
      return world;
    };
    world.queuedCount = function () { return queued.length; };
    world.run = function (runId) {
      var gr = new GlideRecord(kit.TABLE);
      if (runId) {
        gr.get(runId);
      } else {
        gr.addQuery('pd_incident_id', pd.incidentId);
        gr.orderByDesc('sys_created_on');
        gr.setLimit(1);
        gr.query();
        gr.next();
      }
      return gr;
    };
    world.requestedUsers = function () { return pd.requests.map(function (r) { return r.users.slice().sort(); }); };
    world.cleanup = function () {
      var gr = new GlideRecord(kit.TABLE);
      gr.addQuery('pd_incident_id', pd.incidentId);
      gr.query();
      while (gr.next()) { gr.deleteRecord(); }
    };
    return world;
  }
};
