/*** Changes made to this script are not supported by PagerDuty ***/
/**
 * Renotifies an escalation policy (EP) on a PagerDuty incident from ServiceNow.
 *
 * Re-adding an EP as a responder in PagerDuty is not reliable (it re-requests level 1 at best), so this class
 * drives the behaviour itself, level by level, as if the EP was being added for the first time. The decision
 * logic lives in PagerDutyRenotifyMachine (pure, no I/O); this class persists the run in
 * x_pd_integration_renotify_run and performs the PagerDuty calls the machine asks for.
 *
 * Entry points:
 *  - start(): user clicks "Renotify" on an escalation policy.
 *  - renotifyUser(): user clicks "Renotify" on an individual responder.
 *  - handleReplyEvent() / handleResolvedEvent(): called from the inbound v3 webhook handler.
 *  - flush(): executes the actions a run is waiting on (event script action, tick).
 *  - tick(): scheduled job; advances levels whose delay has elapsed.
 */
var PagerDutyRenotify = Class.create();
PagerDutyRenotify.prototype = {
  type: 'PagerDutyRenotify',

  TABLE: 'x_pd_integration_renotify_run',
  EVENT: 'x_pd_integration.renotify_run',
  MAX_ONCALL_PAGES: 5,
  RETENTION_PROPERTY: 'x_pd_integration.renotify_run_retention_days', // 0 keeps finished runs for ever; not shipped as a record, the default is below
  DEFAULT_RETENTION_DAYS: 30,
  REQUESTED_TOLERANCE_MS: 1000, // clock difference allowed between PagerDuty's timestamps and the moment a level became due

  /**
   * @param {Object} [deps] collaborators to use instead of the real ones, so tests need no PagerDuty and no network:
   *   deps.rest() returns an object like PagerDuty_REST, deps.pd() one like PagerDuty (user lookups), deps.defaultUser is the
   *   PagerDuty user to ask on behalf of, deps.incident(snIncidentSysId) returns the PagerDuty incident id it is linked to (or
   *   null when there is no such incident), deps.queue(runRecord) is called instead of queueing the platform event that runs the
   *   follow-up work. Production code passes nothing.
   */
  initialize: function (deps) {
    this.machine = new x_pd_integration.PagerDutyRenotifyMachine();
    this.deps = deps || {};
  },

  /** Queues the platform event that runs the follow-up work of a run (the Script Action calls flush). */
  _queueFlush: function (runRecord) {
    if (this.deps.queue) {
      this.deps.queue(runRecord);
    } else {
      gs.eventQueue(this.EVENT, runRecord, runRecord.getUniqueValue(), '');
    }
  },

  _newRest: function () {
    return this.deps.rest ? this.deps.rest() : new x_pd_integration.PagerDuty_REST();
  },

  _newPd: function () {
    return this.deps.pd ? this.deps.pd() : new x_pd_integration.PagerDuty();
  },

  /**
   * Starts renotifying an EP on an incident and sends the first level synchronously so the caller sees failures.
   * @param {String} snIncidentSysId incident sys_id
   * @param {String} pdPolicyId PagerDuty escalation policy id
   * @param {String} snUserSysId sys_user of the person clicking Renotify (becomes the PagerDuty requester)
   * @returns {{runId:String, policyName:String}}
   */
  start: function (snIncidentSysId, pdPolicyId, snUserSysId) {
    var me = 'start';
    var context = this._requestContext(snIncidentSysId, snUserSysId);
    var pdIncidentId = context.pdIncidentId;
    var requesterPdId = context.requesterPdId;

    if (this._findActiveRun(pdIncidentId, pdPolicyId)) {
      throw new Error('This escalation policy is already being renotified on this incident');
    }

    var policy = this._getPolicy(pdPolicyId);
    var built = this.machine.buildRules(policy);

    var started = this.machine.start({
      incidentId: pdIncidentId,
      policyId: pdPolicyId,
      requesterId: requesterPdId,
      rules: built.rules,
      numLoops: built.numLoops
    }, this._now());

    var gr = this._insertRun(started.run, snIncidentSysId, policy.name);
    this._apply(gr, started.run, started.actions);
    this.flush(gr.getUniqueValue());

    gr.get(gr.getUniqueValue());
    if (gr.getValue('state') === 'failed') {
      throw new Error(gr.getValue('last_error'));
    }
    gs.debug('{0} started run {1} for policy {2}', me, gr.getUniqueValue(), pdPolicyId);
    return { runId: gr.getUniqueValue(), policyName: policy.name };
  },

  /**
   * Requests one responder again, whether they were added on their own or through an escalation policy.
   * No escalation logic: PagerDuty notifies them, and their reply is theirs to give.
   * @param {String} snIncidentSysId incident sys_id
   * @param {String} pdUserId PagerDuty user id of the responder
   * @param {String} snUserSysId sys_user of the person clicking Renotify (becomes the PagerDuty requester)
   * @returns {{pdUserId:String}}
   */
  renotifyUser: function (snIncidentSysId, pdUserId, snUserSysId) {
    if (gs.nil(pdUserId)) {
      throw new Error('Please choose a responder to renotify');
    }
    var context = this._requestContext(snIncidentSysId, snUserSysId);
    this._requestResponders(null, {
      incidentId: context.pdIncidentId,
      requesterId: context.requesterPdId,
      userIds: [pdUserId]
    }, null);
    return { pdUserId: pdUserId };
  },

  /**
   * Stops an active run. Whatever has already been requested stays requested in PagerDuty.
   * @param {String} runSysId
   */
  cancel: function (runSysId) {
    var gr = new GlideRecord(this.TABLE);
    if (!gr.get(runSysId) || gr.getValue('active') !== '1') {
      return;
    }
    var run = JSON.parse(gr.getValue('run_json'));
    run.state = 'cancelled';
    run.phase = null;
    this._apply(gr, run, []);
  },

  /**
   * incident.responder.replied webhook (v3). Updates matching runs and queues the follow-up work.
   * @param {Object} payload v3 webhook payload
   */
  handleReplyEvent: function (payload) {
    var me = 'handleReplyEvent';
    var data = payload.data;
    if (gs.nil(data) || gs.nil(data.incident) || gs.nil(data.user)) {
      return;
    }
    var repliedAt = new Date(payload.occurred_at).getTime();
    var runs = this._activeRuns(data.incident.id);
    while (runs.next()) {
      var run = JSON.parse(runs.getValue('run_json'));
      var result = this.machine.onReply(run, data.user.id, data.state, this._now(), isNaN(repliedAt) ? undefined : repliedAt);
      this._apply(runs, result.run, result.actions);
      if (result.actions.length) {
        this._queueFlush(runs);
      }
      gs.debug('{0} run={1} user={2} state={3} -> {4}', me, runs.getUniqueValue(), data.user.id, data.state, result.run.state);
    }
  },

  /**
   * incident.resolved webhook (v3). Ends active runs on that incident.
   * @param {Object} payload v3 webhook payload
   */
  handleResolvedEvent: function (payload) {
    if (gs.nil(payload.data) || gs.nil(payload.data.id)) {
      return;
    }
    var runs = this._activeRuns(payload.data.id);
    while (runs.next()) {
      var result = this.machine.onIncidentStatus(JSON.parse(runs.getValue('run_json')), 'resolved', false);
      this._apply(runs, result.run, []);
    }
  },

  /**
   * Scheduled job: advance levels whose delay has elapsed, then run what is queued.
   * @param {String} [pdIncidentId] only advance runs on this PagerDuty incident (tests use it to leave other runs alone)
   */
  tick: function (pdIncidentId) {
    var runs = this._activeRuns(pdIncidentId);
    while (runs.next()) {
      var before = runs.getValue('run_json');
      var result = this.machine.onTick(JSON.parse(before), this._now());
      var actions = result.actions;
      if (!actions.length && result.run.phase === 'resolving' && gs.nil(runs.getValue('pending_actions'))) {
        // Recovery: a flush died after claiming its actions, leaving the run waiting for a level to be resolved.
        actions = [{ type: 'resolveLevel', level: result.run.rules[result.run.levelIndex].level }];
      }
      // Save whenever the run changed, not only when there is something to send: running out of levels (exhausted) has no action.
      if (actions.length || JSON.stringify(result.run) !== before) {
        this._apply(runs, result.run, actions);
      }
      this.flush(runs.getUniqueValue());
    }
    this._purgeOnceADay();
  },

  /**
   * Deletes finished runs that have not changed for the retention period (property x_pd_integration.renotify_run_retention_days,
   * 30 days by default, 0 keeps them for ever). Active runs are never touched.
   * @param {Number} [retentionDays] overrides the property
   * @param {String} [pdIncidentId] only runs on this PagerDuty incident (tests use it to leave other runs alone)
   * @returns {Number} how many runs were deleted
   */
  purgeFinishedRuns: function (retentionDays, pdIncidentId) {
    var days = retentionDays !== undefined ? retentionDays : this._retentionDays();
    if (!(days > 0)) {
      return 0;
    }
    var cutoff = new Date(this._now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    var finished = new GlideRecord(this.TABLE);
    finished.addQuery('active', false);
    finished.addQuery('sys_updated_on', '<', cutoff);
    if (pdIncidentId) {
      finished.addQuery('pd_incident_id', pdIncidentId);
    }
    finished.query();
    var count = finished.getRowCount();
    if (count > 0) {
      finished.deleteMultiple();
    }
    return count;
  },

  _retentionDays: function () {
    var days = Number(gs.getProperty(this.RETENTION_PROPERTY, String(this.DEFAULT_RETENTION_DAYS)));
    return isNaN(days) ? this.DEFAULT_RETENTION_DAYS : days;
  },

  /** The tick runs every minute: only look for old runs in the first minutes after 03:00 UTC, and never let that break the tick. */
  _purgeOnceADay: function () {
    var now = new Date(this._now());
    if (now.getUTCHours() !== 3 || now.getUTCMinutes() >= 5) {
      return;
    }
    try {
      var deleted = this.purgeFinishedRuns();
      if (deleted) {
        gs.info('PagerDutyRenotify purged {0} finished renotification run(s)', deleted);
      }
    } catch (ex) {
      gs.warn('PagerDutyRenotify could not purge old runs: {0}', ex.message);
    }
  },

  /**
   * Executes the actions a run is waiting on. Safe to call when nothing is pending.
   * @param {String} runSysId
   */
  flush: function (runSysId) {
    var me = 'flush';
    var gr = new GlideRecord(this.TABLE);
    if (!gr.get(runSysId)) {
      return;
    }
    var pending = this._parse(gr.getValue('pending_actions'), []);
    if (!pending.length) {
      return;
    }
    // Claim the actions before doing I/O so a concurrent flush does not send them twice.
    gr.setValue('pending_actions', '');
    gr.update();

    var run = JSON.parse(gr.getValue('run_json'));
    var queue = pending.slice();
    var error = '';
    try {
      while (queue.length && run.state === 'active') {
        var action = queue.shift();
        if (action.type === 'resolveLevel') {
          var userIds = this._getOnCallUserIds(run.policyId, action.level);
          queue = queue.concat(this.machine.onLevelResolved(run, userIds, this._now()).actions);
        } else if (action.type === 'requestResponders') {
          this._requestResponders(run, action, gr.getValue('policy_name'));
        }
      }
    } catch (ex) {
      error = ex.message || String(ex);
      gs.error('{0} run={1} failed: {2}', me, runSysId, error);
      run.state = 'failed';
      run.phase = null;
    }
    this._apply(gr, run, [], error);
  },

  /** Checks the incident and the clicking user are linked to PagerDuty. */
  _requestContext: function (snIncidentSysId, snUserSysId) {
    var pdIncidentId;
    if (this.deps.incident) {
      pdIncidentId = this.deps.incident(snIncidentSysId);
      if (pdIncidentId === null) {
        throw new Error('You can not use this form out of context of existing incident');
      }
    } else {
      var incident = new GlideRecordSecure('incident');
      if (!incident.get(snIncidentSysId)) {
        throw new Error('You can not use this form out of context of existing incident');
      }
      pdIncidentId = incident.getValue('x_pd_integration_incident');
    }
    if (gs.nil(pdIncidentId)) {
      throw new Error('Current incident is not linked to PagerDuty');
    }
    var requesterPdId = this._newPd().getUserIDFromFieldData(snUserSysId, 'sys_id', true);
    if (gs.nil(requesterPdId)) {
      throw new Error('Current user is not mapped to a PagerDuty user');
    }
    return { pdIncidentId: pdIncidentId, requesterPdId: requesterPdId };
  },

  _getPolicy: function (pdPolicyId) {
    var rest = this._newRest();
    var result = rest.getREST('escalation_policies/' + pdPolicyId);
    this._assertOk(rest, result, 'Could not fetch the escalation policy');
    return JSON.parse(result.getBody()).escalation_policy;
  },

  /**
   * On-calls are resolved when each level is reached, as PagerDuty does, so shift changes during a long run count.
   * @returns {String[]} PagerDuty user ids on call for the level right now
   */
  _getOnCallUserIds: function (pdPolicyId, level) {
    var rest = this._newRest();
    var oncalls = [];
    var offset = 0;
    for (var page = 0; page < this.MAX_ONCALL_PAGES; page++) {
      // The brackets must be percent-encoded: the platform's REST client rejects a raw '[]' in the query ("Invalid query").
      var feature = 'oncalls?escalation_policy_ids%5B%5D=' + encodeURIComponent(pdPolicyId) + '&limit=100&offset=' + offset;
      var result = rest.getREST(feature);
      this._assertOnCallsAllowed(result);
      this._assertOk(rest, result, 'Could not fetch on-calls');
      var body = JSON.parse(result.getBody());
      oncalls = oncalls.concat(body.oncalls || []);
      if (!body.more) {
        break;
      }
      offset += 100;
    }
    return this.machine.usersForLevel(oncalls, level);
  },

  /**
   * PagerDuty may already have asked someone for this level itself: a policy added to the incident keeps escalating, and a
   * decline moves it on. They were just notified, so asking again would send a second text. Returns the people still to ask.
   * Best effort: when PagerDuty cannot be read everyone is asked.
   */
  _notYetRequested: function (run, action) {
    var me = '_notYetRequested';
    if (gs.nil(run) || gs.nil(run.resolveStartedAt)) {
      return action.userIds;
    }
    try {
      var rest = this._newRest();
      var result = rest.getREST('incidents/' + action.incidentId);
      if (rest.hasError() || gs.nil(result) || result.haveError()) {
        return action.userIds;
      }
      var since = run.resolveStartedAt - this.REQUESTED_TOLERANCE_MS;
      var justAsked = {};
      var askedAt = {};
      (JSON.parse(result.getBody()).incident.incidents_responders || []).forEach(function (responder) {
        if (responder.state === 'pending' && responder.user && new Date(responder.requested_at).getTime() >= since) {
          justAsked[responder.user.id] = true;
          askedAt[responder.user.id] = new Date(responder.requested_at).getTime();
        }
      });
      var toAsk = action.userIds.filter(function (id) { return !justAsked[id]; });
      if (toAsk.length !== action.userIds.length) {
        // their answers count from when PagerDuty asked them
        this.machine.onAlreadyAsked(run, askedAt);
        gs.debug('{0} PagerDuty had already asked {1} of {2} for this level', me, action.userIds.length - toAsk.length, action.userIds.length);
      }
      return toAsk;
    } catch (ex) {
      gs.warn('{0} could not check who PagerDuty already asked: {1}', me, ex.message);
      return action.userIds;
    }
  },

  _requestResponders: function (run, action, policyName) {
    var pd = this._newPd();
    var rest = this._newRest();
    var message = policyName
      ? 'Renotification of escalation policy "' + policyName + '" requested from ServiceNow'
      : 'Renotification requested from ServiceNow';

    // PagerDuty silently ignores a request whose requester is the responder (no state change, no notification), and the
    // person clicking Renotify may be on call too. Their own request is therefore made on behalf of someone else.
    var toAsk = this._notYetRequested(run, action);
    var others = toAsk.filter(function (id) { return id !== action.requesterId; });
    var requesterHimself = toAsk.filter(function (id) { return id === action.requesterId; });
    var batches = [];
    if (others.length) {
      batches.push({ requesterId: action.requesterId, userIds: others });
    }
    if (requesterHimself.length) {
      batches.push({ requesterId: this._otherRequester(action.requesterId), userIds: requesterHimself });
    }

    for (var b = 0; b < batches.length; b++) {
      var batch = batches[b];
      var body = {
        requester_id: batch.requesterId,
        message: message,
        responder_request_targets: batch.userIds.map(function (id) {
          return { responder_request_target: { id: id, type: 'user_reference' } };
        })
      };
      var from = pd.getUserEmailByPDID(batch.requesterId);
      var result = rest.postREST('incidents/' + action.incidentId + '/responder_requests', body, from);
      this._assertOk(rest, result, 'Could not request responders');
    }
  },

  /** Another PagerDuty user to make a request on behalf of: the app's default user. */
  _otherRequester: function (requesterPdId) {
    var fallback = this.deps.defaultUser !== undefined ? this.deps.defaultUser : gs.getProperty('x_pd_integration.default_user');
    if (gs.nil(fallback) || fallback === requesterPdId) {
      gs.warn('_otherRequester there is no other PagerDuty user to ask {0} on behalf of; PagerDuty will ignore the request', requesterPdId);
      return requesterPdId;
    }
    return fallback;
  },

  /**
   * PagerDuty refusing the on-calls request (401/403) is, on an installation that uses scoped OAuth, almost always the missing
   * oncalls.read scope, which the integration's shipped provider does not request. Say so, instead of only the HTTP error.
   */
  _assertOnCallsAllowed: function (result) {
    var status = !gs.nil(result) && result.getStatusCode ? Number(result.getStatusCode()) : 0;
    if (status === 401 || status === 403) {
      throw new Error('Could not fetch on-calls: PagerDuty refused the request (HTTP ' + status + '). If this installation uses scoped OAuth, ' +
        'the PagerDuty OAuth app and the integration\'s OAuth provider need the oncalls.read scope.');
    }
  },

  _assertOk: function (rest, result, what) {
    if (rest.hasError()) {
      throw new Error(what + ': ' + rest.getError());
    }
    if (gs.nil(result) || result.haveError()) {
      throw new Error(what + ': ' + (result ? result.getErrorMessage() + '. ' + result.getBody() : 'no response'));
    }
  },

  _insertRun: function (run, snIncidentSysId, policyName) {
    var gr = new GlideRecord(this.TABLE);
    gr.initialize();
    gr.setValue('incident', snIncidentSysId);
    gr.setValue('pd_incident_id', run.incidentId);
    gr.setValue('pd_policy_id', run.policyId);
    gr.setValue('policy_name', policyName);
    gr.setValue('requester_pd_id', run.requesterId);
    gr.insert();
    return gr;
  },

  /** Saves the run and the actions it is waiting on; keeps the display columns in sync. */
  _apply: function (gr, run, actions, error) {
    gr.setValue('run_json', JSON.stringify(run));
    if (actions.length) {
      // Append: a duplicate or concurrent event must not discard actions that are still waiting to be sent.
      gr.setValue('pending_actions', JSON.stringify(this._parse(gr.getValue('pending_actions'), []).concat(actions)));
    }
    gr.setValue('state', run.state);
    gr.setValue('active', run.state === 'active');
    gr.setValue('level', run.rules[run.levelIndex] ? run.rules[run.levelIndex].level : 0);
    gr.setValue('loop', run.loop);
    if (error) {
      gr.setValue('last_error', error);
    }
    gr.update();
  },

  _findActiveRun: function (pdIncidentId, pdPolicyId) {
    var gr = new GlideRecord(this.TABLE);
    gr.addQuery('active', true);
    gr.addQuery('pd_incident_id', pdIncidentId);
    gr.addQuery('pd_policy_id', pdPolicyId);
    gr.setLimit(1);
    gr.query();
    return gr.next();
  },

  _activeRuns: function (pdIncidentId) {
    var gr = new GlideRecord(this.TABLE);
    gr.addQuery('active', true);
    if (pdIncidentId) {
      gr.addQuery('pd_incident_id', pdIncidentId);
    }
    gr.query();
    return gr;
  },

  _parse: function (text, fallback) {
    return gs.nil(text) ? fallback : JSON.parse(text);
  },

  _now: function () {
    return new Date().getTime();
  }
};
