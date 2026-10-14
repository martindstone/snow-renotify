/*** Changes made to this script are not supported by PagerDuty ***/
var PagerDutyRenotifyController = x_pd_integration.AjaxHelper.createAjaxController({
  type: 'PagerDutyRenotifyController',

  /**
   * Escalation policies already added to the incident as responders, with the state of any renotification run.
   * @param {String} snIncidentId incident sys_id
   */
  listEscalationPolicies: function listEscalationPolicies(snIncidentId) {
    var pdPolicyIds = [];
    var requests = new GlideRecordSecure('x_pd_integration_pagerduty_response_requests');
    requests.addQuery('incident', snIncidentId);
    requests.addNotNullQuery('pd_group_id');
    requests.query();
    while (requests.next()) {
      var pdPolicyId = requests.getValue('pd_group_id');
      if (!gs.nil(pdPolicyId) && pdPolicyIds.indexOf(pdPolicyId) === -1) {
        pdPolicyIds.push(pdPolicyId);
      }
    }

    var items = pdPolicyIds.map(function (pdPolicyId) {
      var run = findLatestRun(snIncidentId, pdPolicyId);
      var item = {
        id: pdPolicyId,
        text: getPolicyName(pdPolicyId),
        runId: run ? run.getUniqueValue() : '',
        runState: run ? run.getValue('state') : '',
        runLevel: run ? run.getValue('level') : '',
        runActive: run ? run.getValue('active') === '1' : false
      };
      if (run) {
        addRunDetails(item, run);
      }
      return item;
    });
    return { items: items };
  },

  /**
   * Everyone already added to the incident as a responder, once each, whether they were added on their own or
   * through an escalation policy (a policy adds its on-call users one by one).
   * @param {String} snIncidentId incident sys_id
   */
  listResponders: function listResponders(snIncidentId) {
    var byUser = {};
    var order = [];
    var requests = new GlideRecordSecure('x_pd_integration_pagerduty_response_requests');
    requests.addQuery('incident', snIncidentId);
    requests.addNotNullQuery('pd_user_id');
    requests.orderByDesc('sys_updated_on'); // newest row first: it carries the current state
    requests.query();
    while (requests.next()) {
      var pdUserId = requests.getValue('pd_user_id');
      if (gs.nil(pdUserId)) {
        continue;
      }
      if (!byUser[pdUserId]) {
        byUser[pdUserId] = {
          id: pdUserId,
          snName: requests.assigned_to.nil() ? '' : requests.assigned_to.getDisplayValue(),
          state: stateLabel(requests.getValue('state')),
          updated: requests.getDisplayValue('sys_updated_on'),
          individually: false,
          policyIds: []
        };
        order.push(pdUserId);
      }
      var pdPolicyId = requests.getValue('pd_group_id');
      if (gs.nil(pdPolicyId)) {
        byUser[pdUserId].individually = true;
      } else if (byUser[pdUserId].policyIds.indexOf(pdPolicyId) === -1) {
        byUser[pdUserId].policyIds.push(pdPolicyId);
      }
    }

    var items = order.map(function (pdUserId) {
      var u = byUser[pdUserId];
      var via = u.policyIds.map(function (id) { return getPolicyName(id); });
      if (u.individually) {
        via.unshift('individually');
      }
      return {
        id: pdUserId,
        text: u.snName || getUserName(pdUserId),
        state: u.state,
        updated: u.updated,
        via: via.join(', ')
      };
    });
    return { items: items };
  },

  renotifyUser: function renotifyUser(data) {
    new x_pd_integration.PagerDutyRenotify().renotifyUser(data.snIncidentId, data.pdUserId, data.currentUser);
    return { message: 'Renotification request sent' };
  },

  renotify: function renotify(data) {
    var result = new x_pd_integration.PagerDutyRenotify().start(data.snIncidentId, data.pdPolicyId, data.currentUser);
    return {
      runId: result.runId,
      message: 'Renotifying escalation policy "' + result.policyName + '", starting at level 1'
    };
  },

  cancel: function cancel(runId) {
    new x_pd_integration.PagerDutyRenotify().cancel(runId);
    return { message: 'Renotification stopped' };
  }
});

/**
 * The app records only pending, joined and declined and stores anything else as '(unknown)'. The one other state PagerDuty
 * has is user_cancelled (a request that was cancelled, for instance when a renotification takes over), so show that.
 */
function stateLabel(state) {
  return state === '(unknown)' ? 'Cancelled' : state;
}

/**
 * What the dialog shows about a run beyond its state: how far it has got, who it is waiting on, when it started and why it failed.
 * Best effort: a run whose saved state cannot be read still lists with the basics.
 */
function addRunDetails(item, run) {
  item.runStarted = run.getDisplayValue('sys_created_on');
  item.runUpdated = run.getDisplayValue('sys_updated_on');
  item.runLoop = run.getValue('loop');
  item.runError = run.getValue('last_error') || '';
  item.runWaiting = [];
  try {
    var saved = JSON.parse(run.getValue('run_json'));
    item.runLevelCount = saved.rules.length;
    item.runNumLoops = saved.numLoops;
    if (item.runActive) {
      Object.keys(saved.responses || {}).forEach(function (pdUserId) {
        item.runWaiting.push({ name: getUserName(pdUserId), state: saved.responses[pdUserId] });
      });
    }
  } catch (ex) {
    item.runLevelCount = 0;
    item.runNumLoops = 0;
  }
}

function getPolicyName(pdPolicyId) {
  var ep = new GlideRecordSecure('x_pd_integration_escalation_policies');
  ep.addQuery('escalation_policy_id', pdPolicyId);
  ep.setLimit(1);
  ep.query();
  if (ep.next()) {
    return ep.getValue('escalation_policy_name');
  }
  return nameFromPagerDuty('escalation_policies/' + pdPolicyId, 'escalation_policy') || pdPolicyId;
}

/** Name of a PagerDuty user: the ServiceNow user mapped to it, else PagerDuty's own name, else the id. */
function getUserName(pdUserId) {
  var user = new GlideRecordSecure('sys_user');
  user.addQuery('x_pd_integration_pagerduty_id', pdUserId);
  user.setLimit(1);
  user.query();
  if (user.next()) {
    return user.getValue('name');
  }
  return nameFromPagerDuty('users/' + pdUserId, 'user') || pdUserId;
}

/** Best effort: a name lookup must never stop the dialog from opening. */
function nameFromPagerDuty(feature, key) {
  try {
    var rest = new x_pd_integration.PagerDuty_REST();
    var result = rest.getREST(feature);
    if (rest.hasError() || gs.nil(result) || result.haveError()) {
      return '';
    }
    var record = JSON.parse(result.getBody())[key];
    return record && record.name ? record.name : '';
  } catch (ex) {
    return '';
  }
}

function findLatestRun(snIncidentId, pdPolicyId) {
  var run = new GlideRecordSecure('x_pd_integration_renotify_run');
  run.addQuery('incident', snIncidentId);
  run.addQuery('pd_policy_id', pdPolicyId);
  run.orderByDesc('sys_created_on');
  run.setLimit(1);
  run.query();
  return run.next() ? run : null;
}
