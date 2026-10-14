# Escalation policy renotification

PagerDuty only lets an escalation policy (EP) be added to an incident once; users can be re-requested any number of times. This project emulates "re-adding" an EP by re-requesting its current on-calls level by level.

## Implementation
All ServiceNow records live in this project's `src/`, in the same layout as the integration app, as an **overlay**: new records only, no edits to existing ones. `PagerDutyRenotifyMachine` is synced from `lib/renotify.js` with `scripts/sync-to-src.js`. Records: Script Includes `PagerDutyRenotifyMachine` / `PagerDutyRenotify` / `PagerDutyRenotifyController`, event + Script Action, one-minute scheduled job, Business Rule `PD Renotify Escalation Policy on Webhook` (after insert on `x_pd_integration_webhook_import`), table `x_pd_integration_renotify_run`, the `Renotify` UI Action + `renotify_dialog`, and ACLs. `test/executor.test.js` runs the real Script Include against a fake platform; the optional ATF package (`addons/tests`) runs it on an instance. It has been exercised end to end on a PDI against a real PagerDuty account (see "Updates after end-to-end testing").

## Updates after end-to-end testing
- `GET /oncalls` must be called with `escalation_policy_ids%5B%5D=` (the platform's REST client rejects a raw `[]` in the query).
- Responder `state` is per user, so a renotified person's decline also advances PagerDuty's own request for the policy, and the next level
  is asked by PagerDuty and by ServiceNow. Cancelling that request (`PUT .../responder_requests/cancel`) does not hold: asking the person
  again re-activates it. So the executor reads the incident before asking a level and skips anyone PagerDuty asked after the level became
  due (`run.resolveStartedAt`: the decline as PagerDuty stamps it, or the moment the delay expired). The skipped person's answer counts
  from PagerDuty's request time (`run.askedAt`).
- **A request where requester = responder is ignored** (200, no state change, no notification). The run requests the clicking user
  through a different requester (the app's default user). Verified both ways on the PDI: requested by the person themselves, the
  state stayed `user_cancelled`; requested by another user, it became `pending` in the same second. A cancelled (`user_cancelled`)
  user *can* be requested again by someone else.
- The dialog lists individuals too (one row per person from the response request table) with a plain re-request, no run.
- SMS replies from alias users work (accept and decline), and map to the right user although the number is shared.

## Decision
Re-adding an EP in PagerDuty is not reliable (it renotifies level 1 at best, and does nothing for later levels; see "Rung 1"). So ServiceNow drives the behaviour itself, mirroring what PagerDuty does the first time an EP is added.

## Behaviour (implemented in `lib/renotify.js`)
On "Renotify EP", for the chosen EP (from `escalation_policy_requests` on `incidents_responders` / `responder_requests` of the incident):
1. Start at level 1, whatever each user's earlier state (declined, joined, pending).
2. Resolve who is on call for that level *now* (`GET /oncalls?escalation_policy_ids[]=`, filter `escalation_level`), request them via `POST /incidents/{id}/responder_requests` (user targets). Their state goes back to pending.
3. Wait up to the level's `escalation_delay_in_minutes`.
4. A user **joins** -> stop; nothing else is touched (no cancels).
5. Everyone requested on the level **declines**, or the delay elapses with no join -> next level, resolved at that moment.
6. After the last level, repeat the EP up to `num_loops` more times, then stop. A level with nobody on call is skipped at once.
7. Stop if the incident resolves. Acknowledging auto-joins pending responders, which already yields a `joined` reply.

Example: A 15m, B 15m, C 15m, repeat 3 with A declined and B joined beforehand -> A is asked and made pending; if A declines or 15m pass, B is asked again; then C; then back to A, up to 3 more passes; any join stops it.

## Flow / wiring
1. UI lists EPs already on the incident; user picks one.
2. `GET /escalation_policies/{id}` -> `Renotify.buildRules`; `Renotify.start` -> action `resolveLevel`.
3. Executor fetches `/oncalls` -> `Renotify.usersForLevel` -> `Renotify.onLevelResolved` -> action `requestResponders` -> POST responder request.
4. Webhook `incident.responder.replied` -> `Renotify.onReply(run, userId, state, now, eventTime)`. Pass the event time: replies older than the level's request are ignored. Detect replies by event, never by diffing `state` (see observations).
5. Scheduled job (every minute) -> `Renotify.onTick` for active runs.
6. `incident.resolved` -> `Renotify.onIncidentStatus`.
7. The executor must call `onLevelResolved` right after `resolveLevel`; a run stuck in phase `resolving` (executor failure) needs a sweep to retry or fail it.

## Verified against PagerDuty docs / OpenAPI (2026-09-30)
Sources: PagerDuty/api-schema `reference/REST/openapiv3.json`, docs.pagerduty.com (webhooks-overview, webhook-behavior), support.pagerduty.com Add Responders.

| Topic | Verified fact | Corrects |
|---|---|---|
| On-calls | `GET /oncalls`, scope `oncalls.read`, filter `escalation_policy_ids[]`. Entry: `escalation_level` (int), `user`, `schedule`, `escalation_policy`, `start`/`end` (null = permanent). Defaults to now; paginated (`limit`/`offset`). `schedule_ids[]=null` covers direct-user targets. | There is no `/escalation_policies/oncalls` (old v1 path, gone). |
| EP config | `num_loops` (int, default 0); rules in `escalation_rules[]` (delay `escalation_delay_in_minutes`). | Rule-index == `escalation_level` is still an assumption; confirm with a real EP. |
| Request | `POST /incidents/{id}/responder_requests`, scope `incidents.write`; body `requester_id`, `message`, `responder_request_targets[]` all **required** (message can't be omitted). Target `{responder_request_target:{id,type}}`, types `user_reference` / `escalation_policy_reference`. 402 if account lacks `coordinated_responding`. | `message` required. |
| States | `pending`, `joined`, `declined`, `user_cancelled`. | I used `accepted`; it is `joined`. Added `user_cancelled`. |
| Notification | Targets are notified via **high-urgency** notification rules until they accept or decline. Acknowledging the incident auto-accepts the user's pending requests. | I claimed responder-request rules; wrong. Also: an acknowledge produces `joined` replies. |
| Cancel | `PUT /incidents/{id}/responder_requests/cancel` (`incidents.write`): only `pending` targets are cancelled, sets `user_cancelled`; result per target `cancelled`/`joined`/`declined`/`not_found`. For an EP target it stops the escalation. | Looked like a native way to stop notifying; it does not hold (see "Updates after end-to-end testing"). |
| Reading state | `GET /incidents/{id}` returns `incidents_responders[]` (state, user, `escalation_policy_requests` = EP names) and `responder_requests[]` (targets with `incident_responders`). Only when the account has the feature. | Existing app's `FetchResponders` already reads these. |
| Webhook | v3 `incident.responder.added` / `.replied`, scope `incidents.read`. `data`: `incident`, `user`, `escalation_policy` ref, `message`, `state`, `type: incident_responder`. Docs example only shows `pending`. | `joined`/`declined` in webhooks is inferred from the REST enum and the existing app's mapping, not documented. |
| Delivery | At-least-once (dedupe on `X-Webhook-Id`), in order per incident, 5s ack, retried up to 48h, subscription disabled after 3 consecutive drops. | Handlers must be idempotent (the app already dedupes on payload id). |
| Limits | Per incident: 500 unique responders, 1,000 responder requests. | Every renotification burns request quota; cap runs. |

## Re-check against the new docs (llms.txt, 2026-10-06)
- New page [Renotify a Responder](https://docs.pagerduty.com/incident-management/incidents/renotify-a-responder): the web UI can send a new notification (with message, optional dial-in/meeting URL) to a responder who was already requested, and cancel a still-pending notification; a cancelled one shows a **Renotify** button. Each action lands in the incident timeline. It says "one or more responders who were already requested" and, on Add Responders, "if a responder's status remains Pending, you can renotify". It does **not** say whether `declined` or `joined` responders can be renotified.
- **No documented REST endpoint for renotify.** The API list in llms.txt and the OpenAPI spec still have only create and cancel responder requests. Whether the UI action is a call to create-responder-request or an internal API is unknown.
- Add Responders page confirms: statuses Joined / Declined / Pending; EP targets page every on-call user at each level "until someone accepts the invitation or the incident resolves"; the incident keeps escalating by its own service EP regardless; ack auto-accepts pending requests (also on bulk ack); 500 unique responders / 1,000 requests per incident.
- Create-request page still shows only `pending` and `user_reference`; the full enum and `escalation_policy_reference` come from the OpenAPI schema and the existing app's code.
- Webhook docs unchanged: `incident_responder` example shows only `state: "pending"`.

## Confirmed by hand (2026-10-06)
- Re-posting `POST /incidents/{id}/responder_requests` for a **user** renotifies them.
- Re-posting it for an **escalation policy** that is already on the incident does nothing. This is why we expand the EP to its current on-calls ourselves.

## Observed live against the dev account (2026-10-07; throwaway experiment scripts, not kept, incident #91683)
Setup: incident assigned to a test user, requester the same test user, target the tester; the test EP has one level, one direct user target (the tester), `num_loops=0`.

| Step | Result |
|---|---|
| Re-post user while `pending` | 200, `responder_requests` grows, still one `incidents_responders` row, `pending`. |
| User declines, then re-post **user** | 200, **user is notified again**, but `state` stays `declined` and `updated_at` is unchanged. No `notify_log_entry` appears in the log, but the notification was received. (Contradicts "state goes back to pending": observed state did not reset on a user re-post.) |
| Then post **EP** (first time on this incident) | 200, user notified, state -> `pending`, `escalation_policy_requests` = [EP name]. |
| Post **same EP again** | 200, **user notified again**, state unchanged, `escalation_policy_requests` gets a duplicate name, `responder_requests` +1. The API does not reject duplicate EPs. |
| User declines once | **All** outstanding requests for that user close at once (state is per user per incident, not per request); log gets one `responder_decline_log_entry` (`updated_at` moves) plus, for each EP request, "Request for <EP> looped through its escalation policy the maximum number of times." |

Implications:
- State is per user per incident. A reply (join/decline) answers every open request for that user, including native EP requests; we cannot track "our" request separately from a native one.
- Detect a reply by event (webhook id, or `updated_at` / `responder_decline_log_entry` newer than our request), never by diffing `state`: a re-notified declined user who declines again leaves `state` = `declined`.
- The "EP does nothing" behaviour is probably about an EP request that has already run its course (all targets declined and loops exhausted: the log line above), not a rejected API call. Unverified; reproduce with a multi-level EP.
- Still unverified: whether `incident.responder.replied` fires on a second decline (log entries suggest yes); re-posting for a `joined` user.

### EP added -> responder joins -> EP re-added (incident #91684)
Single-level test EP (one direct user). After the join, re-posting the same EP returned 200, the user's state went `joined` -> `pending` about 4s later, `responder_requests` +1, `escalation_policy_requests` gained a duplicate name, and **the user was notified** (reported by the tester). No `notify_log_entry` was written for it, so the log is **not** a reliable proxy for "was notified". This did **not** reproduce the "EP re-add does nothing" behaviour; that case likely needs a multi-level EP, multiple users, or a different timing/state. Still to reproduce.

### Rung 1: two-level EP, L1 Demo User 1 (never replies), L2 the tester, 1m delays (incident #91685)
Timeline (UTC): EP added 00:36:26 -> L1 requested at once; L2 (the tester) added to `incidents_responders` at 00:37:27 (+61s).
- **Re-add while both pending (00:39:04):** 200, `responder_requests` +1, response lists only L1; no state change in either responder. the tester was notified (timing relative to the re-add not captured).
- **The tester declines (00:41:16), then re-add (00:41:44):** 200, `responder_requests` +1, response lists only L1 (still `pending`). the tester's state **stayed `declined`** for the 2+ min polled and **he received no notification**. This reproduces "re-adding an EP does nothing". Contrast with the single-level EP, where the same sequence set the user to `pending` within ~3s and notified them.
- Working hypothesis (untested): PagerDuty treats the EP request as still in flight while an earlier level (Demo User 1) is `pending`, so a re-add only logs a request and does not restart escalation. To isolate: let L1 finish (join via ack as Demo User 1) and re-add again.

- **L1 joins (ack as Demo User 1, 00:45:11), then re-add (00:45:18):** 200, `responder_requests` +1. Demo User 1 went `joined` -> `pending` within ~2s (L1 is re-requested). the tester (L2) stayed `declined` for the 100s polled, well past the 1m level delay, so the re-added EP did **not** escalate to L2 again. Hypothesis "L1 pending blocks the re-add" is **rejected**; a re-add re-requests level 1 but does not re-escalate to levels whose user has already declined (or the re-run never escalates; need a non-declined L2 to tell).

## Webhook behaviour observed live (2026-10-08; a throwaway webhook receiver behind ngrok, not kept, subscription scoped to a test service)
Envelope: `event.id`, `event_type`, `resource_type`, `occurred_at`, `agent` (user who made the request), `client`, `data`. `X-Webhook-Id` header repeats on retries.

| Action | Event | `data.state` | notes |
|---|---|---|---|
| Request a user | `incident.responder.added` | `pending` | `data.message` = request message; `escalation_policy` null for user targets |
| User declines | `incident.responder.replied` | `declined` | `message` null |
| Re-post for a declined user | `incident.responder.added` | `pending` | fires even though the REST `state` still read `declined` at that time |
| Second decline of a re-request | `incident.responder.replied` | `declined` | **a second `replied` does fire** |
| User joins (re-request) | `incident.responder.replied` | `joined` | |
| Re-post for an already-joined user | `incident.responder.added` | `pending` | |
| Request via EP | `incident.responder.added` | `pending` | `data.escalation_policy` populated (id, summary) |

Conclusions:
- `replied` fires on every reply, including repeated declines, so webhooks are enough to drive a run; no polling needed for replies. Payload states are `pending` / `declined` / `joined` (confirmed).
- `added` with `pending` is a reliable "user was just (re)requested" signal and can confirm our own request landed.
- Still untested: the `replied` payload for a user who answers an EP-originated request (is `escalation_policy` set?). Not needed by the design, since we match on incident + user + event time.

## Questions that were open, and how they ended
- Does a re-requested `declined`/`joined` user go back to `pending`, and does the reply webhook fire again? Yes to both: `added` with `pending`, and a later `replied` for every reply (see "Webhook behaviour observed live"). The REST `state` can lag the webhook, which is why replies are detected by event.
- Are `joined`/`declined` the literal state strings in `incident.responder.replied` payloads? Yes, along with `pending` and `user_cancelled` (the REST enum).
- Do earlier levels keep notifying after we advance? PagerDuty's own escalation of a natively added policy can ask the next level at about the same moment; the executor avoids a second text by skipping people PagerDuty has just asked (see "Updates after end-to-end testing"). It does not cancel anything.
- Does `escalation_policy` in the webhook payload tell our runs apart from native EP responders? Not needed: replies are matched on incident, person and event time.

## Open items
- Scoped OAuth: customers on scoped OAuth must add `oncalls.read` to their PagerDuty OAuth app and the provider's scope list themselves (documented in the README); the overlay does not ship it. `escalation_policies.read`, `incidents.read` and `incidents.write` already exist.
- A person can still be asked twice when PagerDuty's own escalation fires just after the executor's check (see the ADR).
- The existing app maps webhook states to Pending/Accepted/Declined and shows `(unknown)` for `user_cancelled`; the dialog relabels that as Cancelled but the app's own list does not.
