# 5. Renotify escalation policies from ServiceNow instead of re-adding them in PagerDuty

Date: Oct 8, 2026

## Status

Accepted. Implemented as an overlay on the installed integration, and exercised end to end on a PDI against a real PagerDuty account.

## Context

An incident's responders can include an escalation policy (EP). PagerDuty then pages whoever is on
call at each level of that EP, escalating level by level until someone accepts. Users want to page
the same EP again later in the incident ("Renotify"), but PagerDuty does not support it reliably.

Behaviour observed against a dev PagerDuty account (REST API and v3 webhooks, October 2026):

- Re-posting `POST /incidents/{id}/responder_requests` for a **user** renotifies them. A responder
  that had declined or joined is requested again and the webhook reports `pending`.
- Re-posting the **same EP** returns 200 and logs a request, but only re-requests level 1. With a
  two-level EP whose second-level user had declined, the re-add produced no escalation to level 2
  and no notification.
- Responder state is **per user per incident**, not per request. One decline answers every open
  request for that user, including native EP requests.
- `incident.responder.replied` fires on every reply, including repeated declines, with state
  `declined` or `joined`. The REST `state` does not change on a repeated decline, so replies must be
  detected from events, never by diffing state. Delivery is at-least-once and ordered per incident.

## Decision

ServiceNow drives the renotification itself, mirroring what PagerDuty does the first time an EP is
added. For the chosen EP, starting at level 1 whatever each user's earlier state:

1. Resolve who is on call for the level now (`GET /oncalls?escalation_policy_ids[]=`) and request
   those users individually.
2. Wait for the level's `escalation_delay_in_minutes`.
3. A user **joins**: stop. Nothing else is touched (no cancellations).
4. Everyone requested on the level **declines**, or the delay passes: go to the next level,
   resolving on-calls again at that moment so shift changes during a long run are respected.
5. After the last level, repeat up to the EP's `num_loops`, then stop. A level with nobody on call
   is skipped. The run also ends when the incident resolves.

PagerDuty may already be escalating the policy itself (it was added natively, and a decline moves it on), and asking the same person
again sends a second text. A first attempt cancelled PagerDuty's request when a run started (`PUT .../responder_requests/cancel`); it
did not hold: re-requesting a person puts them back to `pending`, and their next decline then escalated the cancelled request anyway
(observed: PagerDuty asked level 2 at 13:38:30 and ServiceNow five seconds later, two texts). Instead, before asking a level the
executor reads the incident and skips anyone who is `pending` and whom PagerDuty asked after the level became due: the moment of
the decline as PagerDuty stamps it, or the moment the delay expired. The skipped person is still waited for, and their answer counts
from PagerDuty's request time. Best effort: if PagerDuty's escalation fires just after the check, there is still one duplicate.

The dialog also lists the individuals already on the incident (from the response request table, one row per person, however
they were added) and can renotify one person: a single responder request, with no run and no escalation.

Implementation:

- `PagerDutyRenotifyMachine`: pure state machine, no I/O. Replies older than the level's request
  are ignored, so a stale event cannot satisfy a new request.
- `PagerDutyRenotify`: persists runs in `x_pd_integration_renotify_run` and performs the PagerDuty
  calls. A Business Rule on the webhook import table (`x_pd_integration_webhook_import`, after insert) feeds
  `incident.responder.replied` / `incident.resolved` events to the run, so no existing record is
  modified. The run is updated and the event `x_pd_integration.renotify_run` is queued. A one-minute scheduled job
  advances levels whose delay elapsed and recovers a run left waiting after a failed flush.
- `PagerDutyRenotifyController`, the `Renotify` UI Action and the
  `renotify_dialog` UI page: the user lists the EPs already on the incident and starts or stops a run.

## Consequences

- **Authentication.** Calls go through `PagerDuty_REST`, so they use whichever mechanism the installed app uses. For now this
  is validated with the legacy API token only. With Scoped OAuth, resolving on-calls needs `oncalls.read`, which the app's provider
  does not request. The overlay does not ship that scope: `PagerDutyOAuth.validateOutboundOAuth()` blocks save and healthcheck when a
  requested scope is not granted, so adding it would break existing OAuth installs until they re-authorized. Customers on OAuth add
  it themselves (documented in the README).
- A person can still be asked twice when PagerDuty's escalation fires just after the executor's check, or when its timing is not aligned with
  the run's (a timeout in PagerDuty falls at a different moment than a timeout in ServiceNow). Each text has its own response code, and an
  answer to either counts, because a responder's state is per person.
- A renotification run is **ServiceNow's** emulation. A user's reply also answers their native EP
  requests (state is per user), and the notifications use the responder's high-urgency rules.
- Runs are not locked. A duplicate or concurrent webhook cannot lose queued work (actions are
  appended and claimed before any call is made), but a concurrent write to the same run could
  overwrite `run_json`. Runs are short and few, so this is accepted.
- Timing is bounded by the one-minute job: a level timeout fires up to a minute late. Declines and
  joins are handled immediately through the event.
- The tick job is the only thing that notices a level timing out (PagerDuty sends no event for that) and that recovers a run left
  waiting, so it must stay active. It also deletes finished runs older than a retention period (30 days by default, once a day), so the
  run table does not grow without bound.
- Each level requested counts against PagerDuty's limit of 1,000 responder requests per incident.
- Reply handling depends on the `incident.responder.*` v3 webhook events reaching ServiceNow.
