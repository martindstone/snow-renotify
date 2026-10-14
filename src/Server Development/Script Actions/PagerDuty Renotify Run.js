/*** Changes made to this script are not supported by PagerDuty ***/
var me = 'PagerDuty Renotify Run';
gs.debug('{0} event received: run={1}', me, current.getValue('sys_id'));

new x_pd_integration.PagerDutyRenotify().flush(current.getValue('sys_id'));
