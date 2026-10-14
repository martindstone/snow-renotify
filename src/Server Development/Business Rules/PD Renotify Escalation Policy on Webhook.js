/*** Changes made to this script are not supported by PagerDuty ***/
(function executeRule (current, previous) {
  var me = 'PD Renotify Escalation Policy on Webhook';

  // An escalation policy renotification run must never break regular webhook processing.
  try {
    var payload = JSON.parse(current.getValue('payload'));
    var renotify = new x_pd_integration.PagerDutyRenotify();
    if (payload.event_type === 'incident.responder.replied') {
      renotify.handleReplyEvent(payload);
    } else if (payload.event_type === 'incident.resolved') {
      renotify.handleResolvedEvent(payload);
    }
  } catch (ex) {
    gs.error('{0} {1}: {2}', me, current.getValue('message_type'), ex);
  }
})(current, previous);
