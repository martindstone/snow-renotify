/*** Changes made to this script are not supported by PagerDuty ***/
/**
 * Pure state machine that mirrors what PagerDuty does when an escalation policy
 * (EP) is added to an incident as a responder for the first time, driven from
 * ServiceNow because re-adding an EP in PagerDuty is not reliable.
 *
 * Behaviour, per level, starting at level 1 regardless of earlier replies:
 *   1. Resolve who is on call for the level *now* and request them (this makes
 *      them pending again, even if they previously joined or declined).
 *   2. Wait for the level's delay.
 *   3. Any user joins -> stop; nothing else is touched (no cancels).
 *   4. Everyone requested on the level declines, or the delay elapses with no
 *      join -> go to the next level. After the last level, repeat the whole EP
 *      up to num_loops more times, then give up.
 *   A level with nobody on call is skipped immediately.
 *
 * No GlideRecord / HTTP in here: every function takes a run object and returns
 * { run, actions }. The ServiceNow Script Include persists the run and executes
 * the actions, feeding results back in. ES5 so it can be pasted unchanged.
 *
 * Actions:
 *   { type: 'resolveLevel', level }  fetch on-calls for the EP, call onLevelResolved(run, userIds, now)
 *   { type: 'requestResponders', incidentId, requesterId, userIds }  POST /incidents/{id}/responder_requests
 *
 * Each time a level becomes due the run records resolveStartedAt: the executor skips anyone PagerDuty itself asked after
 * that moment (its own escalation of the policy), so they are not asked twice.
 *
 * Run states: active | joined | exhausted | resolved
 * Run phases (while active): resolving | waiting
 * Responder states (PagerDuty): pending | joined | declined | user_cancelled
 */
var Renotify = (function () {
  var MS_PER_MIN = 60000;

  /**
   * @param {Object} policy GET /escalation_policies/{id} escalation_policy
   * @returns {{rules:{level:number, delayMinutes:number}[], numLoops:number}}
   */
  function buildRules(policy) {
    return {
      rules: (policy.escalation_rules || []).map(function (rule, i) {
        // Oncall.escalation_level equals the rule's 1-based position (verified live).
        return { level: i + 1, delayMinutes: rule.escalation_delay_in_minutes };
      }),
      numLoops: policy.num_loops || 0
    };
  }

  /**
   * Distinct users on call for one level, from GET /oncalls?escalation_policy_ids[]=
   * @param {Object[]} oncalls
   * @param {number} level
   * @returns {string[]}
   */
  function usersForLevel(oncalls, level) {
    var ids = [];
    (oncalls || []).forEach(function (o) {
      if (o.escalation_level !== level || !o.user || !o.user.id) return;
      if (ids.indexOf(o.user.id) === -1) ids.push(o.user.id);
    });
    return ids;
  }

  /** @param {number} at when this level became due (used to tell who PagerDuty has already asked for it) */
  function _resolve(run, at) {
    run.phase = 'resolving';
    run.responses = {};
    run.askedAt = {};
    run.resolveStartedAt = at;
    return [{ type: 'resolveLevel', level: run.rules[run.levelIndex].level }];
  }

  function _advance(run, at) {
    if (run.levelIndex + 1 < run.rules.length) {
      run.levelIndex++;
      return _resolve(run, at);
    }
    if (run.loop < run.numLoops) {
      run.loop++;
      run.levelIndex = 0;
      return _resolve(run, at);
    }
    run.state = 'exhausted';
    run.phase = null;
    return [];
  }

  /**
   * @param {{incidentId:string, policyId:string, requesterId:string, rules:Object[], numLoops:number}} params from buildRules
   * @param {number} now epoch ms
   */
  function start(params, now) {
    var run = {
      incidentId: params.incidentId,
      policyId: params.policyId,
      requesterId: params.requesterId,
      rules: params.rules,
      numLoops: params.numLoops || 0,
      loop: 0,
      levelIndex: 0,
      state: 'active',
      phase: null,
      responses: {},
      levelStartedAt: now
    };
    if (!run.rules.length) {
      run.state = 'exhausted';
      return { run: run, actions: [] };
    }
    return { run: run, actions: _resolve(run, now) };
  }

  /** The executor resolved the current level's on-calls. */
  function onLevelResolved(run, userIds, now) {
    if (run.state !== 'active' || run.phase !== 'resolving') return { run: run, actions: [] };
    if (!userIds.length) return { run: run, actions: _advance(run, now) };
    run.phase = 'waiting';
    run.levelStartedAt = now;
    run.responses = {};
    userIds.forEach(function (id) { run.responses[id] = 'pending'; });
    return {
      run: run,
      actions: [{ type: 'requestResponders', incidentId: run.incidentId, requesterId: run.requesterId, userIds: userIds.slice() }]
    };
  }

  /**
   * The executor did not ask these people because PagerDuty had just asked them itself, at the given times (epoch ms).
   * Their answers count from that moment, not from when this level was requested.
   */
  function onAlreadyAsked(run, askedAt) {
    run.askedAt = run.askedAt || {};
    Object.keys(askedAt).forEach(function (id) {
      if (id in run.responses) run.askedAt[id] = askedAt[id];
    });
    return { run: run, actions: [] };
  }

  /**
   * A responder replied (incident.responder.replied webhook).
   * @param {number} [repliedAt] event time; replies older than this level's request are stale and ignored
   */
  function onReply(run, userId, status, now, repliedAt) {
    if (run.state !== 'active' || run.phase !== 'waiting' || !(userId in run.responses)) return { run: run, actions: [] };
    // An answer older than the moment this person was asked cannot be an answer to this request: ours (levelStartedAt) or, for
    // someone PagerDuty asked itself, PagerDuty's own request (askedAt).
    var since = run.askedAt && run.askedAt[userId] !== undefined ? run.askedAt[userId] : run.levelStartedAt;
    if (repliedAt !== undefined && repliedAt < since) return { run: run, actions: [] };
    run.responses[userId] = status;
    if (status === 'joined') {
      run.state = 'joined';
      run.phase = null;
      return { run: run, actions: [] };
    }
    // declined and user_cancelled are terminal non-joins: advance once nobody is left to wait for.
    var nonePending = Object.keys(run.responses).every(function (id) { return run.responses[id] !== 'pending'; });
    // The level became due when the last person answered, as PagerDuty timestamps it, not when this event was processed.
    var due = repliedAt !== undefined && repliedAt <= now ? repliedAt : now;
    return { run: run, actions: nonePending ? _advance(run, due) : [] };
  }

  /** Periodic timer: advance when the current level's delay has elapsed without a join. */
  function onTick(run, now) {
    if (run.state !== 'active' || run.phase !== 'waiting') return { run: run, actions: [] };
    var delay = run.rules[run.levelIndex].delayMinutes * MS_PER_MIN;
    if (now - run.levelStartedAt < delay) return { run: run, actions: [] };
    // The level became due when its delay expired, not when the timer got round to noticing.
    return { run: run, actions: _advance(run, run.levelStartedAt + delay) };
  }

  /** Incident status change: stop on resolved (and optionally acknowledged). */
  function onIncidentStatus(run, status, stopOnAcknowledge) {
    if (run.state === 'active' && (status === 'resolved' || (stopOnAcknowledge && status === 'acknowledged'))) {
      run.state = 'resolved';
      run.phase = null;
    }
    return { run: run, actions: [] };
  }

  return {
    type: 'PagerDutyRenotifyMachine',
    initialize: function () {},
    buildRules: buildRules,
    usersForLevel: usersForLevel,
    start: start,
    onLevelResolved: onLevelResolved,
    onAlreadyAsked: onAlreadyAsked,
    onReply: onReply,
    onTick: onTick,
    onIncidentStatus: onIncidentStatus
  };
})();

if (typeof module !== 'undefined') module.exports = Renotify;
