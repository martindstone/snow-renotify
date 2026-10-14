jQuery(function () {
  var $ = jQuery;
  var modal = GlideModal.get();
  var snIncidentId = modal.getPreference('snIncidentId');
  var api = x_pd_integration.AjaxHelper.ajaxClientFor('PagerDutyRenotifyController');
  var busy = false;
  var REFRESH_MS = 5000;
  var AFTER_ACTION_REFRESHES = 6; // about 30 seconds: a state change reaches ServiceNow by webhook a few seconds after the click
  var PLACEHOLDER = 'Choose an escalation policy or a person…';
  var refreshTimer = null;
  var refreshesAfterAction = 0;
  var policies = [];
  var people = [];
  var selected = '';      // 'policy:<id>' or 'user:<id>', '' when nothing is chosen
  var optionsShown = null;
  var awaiting = {};      // person key -> the state they had when asked again, until PagerDuty's answer reaches ServiceNow

  var $loading = $('.pd-renotify-loading');
  var $message = $('.pd-renotify-message');
  var $picker = $('.pd-renotify-picker');
  var $select = $('.pd-renotify-select');
  var $go = $('.pd-renotify-go');
  var $status = $('.pd-renotify-status');
  var $details = $('.pd-renotify-details');
  var $policiesHeading = $('.pd-renotify-policies-heading');
  var $table = $('.pd-renotify-table');
  var $rows = $('.pd-renotify-rows');
  var $peopleHeading = $('.pd-renotify-people-heading');
  var $peopleTable = $('.pd-renotify-people');
  var $peopleRows = $('.pd-renotify-people-rows');

  function showMessage(text) {
    $loading.hide();
    $message.text(text).show();
    $picker.hide();
    $status.hide();
    $details.hide();
  }

  var RUN_ENDED = {
    joined: { tone: 'good', badge: 'Someone joined', title: 'The run stopped when a responder joined' },
    exhausted: { tone: 'warn', badge: 'Reached the end', title: 'Every level and loop was tried without anyone joining' },
    resolved: { tone: 'muted', badge: 'Stopped', title: 'The incident was resolved' },
    cancelled: { tone: 'muted', badge: 'Stopped', title: 'Stopped from this dialog' },
    failed: { tone: 'bad', badge: 'Failed', title: 'The run stopped because of an error' }
  };

  /** One word for a responder's state, whatever the app calls it: pending, joined, declined or cancelled. */
  function stateKind(state) {
    var text = String(state || '').toLowerCase();
    if (text === 'accepted' || text === 'joined') {
      return 'joined';
    }
    return /^(pending|declined|cancelled)$/.test(text) ? text : '';
  }

  function stateTone(state) {
    return { pending: 'warn', joined: 'good', declined: 'bad', cancelled: 'muted' }[stateKind(state)] || 'muted';
  }

  function plural(count, one, many) {
    return count + ' ' + (count === 1 ? one : many);
  }

  /** A short text for tables and the like: "Renotifying: level 2", "Last run: Someone joined". */
  function policyStatus(item) {
    if (!item.runState) {
      return 'Not renotified';
    }
    if (item.runActive) {
      return 'Renotifying: level ' + item.runLevel;
    }
    return 'Last run: ' + ((RUN_ENDED[item.runState] || {}).badge || item.runState);
  }

  function personStatus(person) {
    var key = 'user:' + person.id;
    if (awaiting[key] !== undefined) {
      if (person.state === awaiting[key] && (busy || refreshesAfterAction > 0)) {
        return 'Request sent, waiting for PagerDuty…';
      }
      delete awaiting[key];
    }
    return person.state || '';
  }

  function policyView(item) {
    var facts = [];
    if (!item.runState) {
      return { kind: 'Escalation policy', name: item.text, tone: 'muted', badge: 'Not renotified', title: '', facts: [['Next', 'Renotify starts at level 1 and asks whoever is on call now']] };
    }
    var view;
    if (item.runActive) {
      var levelOf = item.runLevelCount ? ' of ' + item.runLevelCount : '';
      view = { kind: 'Escalation policy', name: item.text, tone: 'info', badge: 'Renotifying', title: 'Level ' + item.runLevel + levelOf, facts: facts };
      if (item.runNumLoops !== undefined && item.runLevelCount) {
        facts.push(['Round', (Number(item.runLoop) + 1) + ' of ' + (Number(item.runNumLoops) + 1)]);
      }
      if (item.runWaiting && item.runWaiting.length) {
        facts.push(['Waiting on', item.runWaiting.map(function (w) { return w.name + ' (' + w.state + ')'; }).join(', ')]);
      }
    } else {
      var ended = RUN_ENDED[item.runState] || { tone: 'muted', badge: item.runState, title: '' };
      view = { kind: 'Escalation policy', name: item.text, tone: ended.tone, badge: ended.badge, title: ended.title, facts: facts };
      if (item.runState === 'failed' && item.runError) {
        facts.push(['Error', item.runError]);
      }
    }
    if (item.runStarted) {
      facts.push(['Started', item.runStarted]);
    }
    if (item.runUpdated && item.runUpdated !== item.runStarted) {
      facts.push(['Last change', item.runUpdated]);
    }
    return view;
  }

  function personView(person) {
    var text = personStatus(person);
    var facts = [];
    var view;
    if (text.indexOf('Request sent') === 0) {
      view = { kind: 'Individual', name: person.text, tone: 'info', badge: 'Request sent', title: 'Waiting for PagerDuty…', facts: facts };
    } else {
      view = { kind: 'Individual', name: person.text, tone: stateTone(person.state), badge: person.state || 'Unknown', title: '', facts: facts };
    }
    if (person.via) {
      facts.push(['Added', person.via]);
    }
    if (person.updated) {
      facts.push(['Last change', person.updated]);
    }
    return view;
  }

  /** Before anything is chosen: what is on this incident at a glance. */
  function overviewView() {
    var counts = { pending: 0, joined: 0, declined: 0, cancelled: 0 };
    people.forEach(function (person) {
      var kind = stateKind(person.state);
      if (kind) {
        counts[kind]++;
      }
    });
    var running = policies.filter(function (item) { return item.runActive; }).length;
    var chips = [
      { tone: 'warn', text: 'Pending ' + counts.pending },
      { tone: 'good', text: 'Joined ' + counts.joined },
      { tone: 'bad', text: 'Declined ' + counts.declined }
    ];
    if (counts.cancelled) {
      chips.push({ tone: 'muted', text: 'Cancelled ' + counts.cancelled });
    }
    var facts = [];
    if (policies.length) {
      facts.push(['Escalation policies', plural(policies.length, 'policy', 'policies') + (running ? ', ' + running + ' being renotified now' : '') + ' (choose one to renotify it level by level)']);
    }
    if (people.length) {
      facts.push(['Individuals', plural(people.length, 'person', 'people') + ' available to renotify']);
    }
    return { tone: running ? 'info' : 'muted', badge: '', title: 'Choose something to renotify', chips: chips, facts: facts };
  }

  function findSelected() {
    var kind = selected.split(':')[0];
    var id = selected.slice(kind.length + 1);
    var list = kind === 'policy' ? policies : people;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return { kind: kind, item: list[i] };
      }
    }
    return null;
  }

  // A run goes on after the dialog is opened (replies, timeouts), and so does a pending request: keep the status
  // current while either exists, and for a short while after any action, when the change has not arrived yet.
  function scheduleRefresh() {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    var waiting = policies.some(function (item) { return item.runActive; }) ||
      people.some(function (person) { return person.state === 'Pending'; }) ||
      refreshesAfterAction > 0;
    if (!waiting) {
      return;
    }
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      if (!$('.pd-renotify-form').length) {
        return; // the dialog was closed
      }
      if (refreshesAfterAction > 0) {
        refreshesAfterAction--;
      }
      if (!busy) {
        load();
      } else {
        scheduleRefresh();
      }
    }, REFRESH_MS);
  }

  /** Rebuilt only when the choices themselves change, so a refresh never closes the list or loses the selection. */
  function renderOptions() {
    var signature = JSON.stringify([
      policies.map(function (p) { return [p.id, p.text]; }),
      people.map(function (p) { return [p.id, p.text]; })
    ]);
    if (signature === optionsShown) {
      return;
    }
    optionsShown = signature;
    $select.empty().append($('<option></option>').attr('value', '').text(PLACEHOLDER));
    function group(label, kind, list) {
      if (!list.length) {
        return;
      }
      var $group = $('<optgroup></optgroup>').attr('label', label);
      list.forEach(function (item) {
        $group.append($('<option></option>').attr('value', kind + ':' + item.id).text(item.text));
      });
      $select.append($group);
    }
    group('Escalation policies', 'policy', policies);
    group('Individuals', 'user', people);
    if (!findSelected()) {
      selected = '';
    }
    $select.val(selected);
  }

  function paintStatus(view) {
    var $kind = view.kind
      ? $('<div class="pd-status-kind"></div>')
        .append($('<span class="pd-kind-tag"></span>').addClass(view.kind === 'Individual' ? 'individual' : 'policy').text(view.kind))
        .append($('<span class="pd-kind-name"></span>').text(view.name))
      : '';
    var $head = $('<div class="pd-status-head"></div>');
    if (busy) {
      $head.append($('<span class="pd-renotify-spinner small" aria-hidden="true"></span>'));
    }
    if (view.badge) {
      $head.append($('<span class="pd-badge"></span>').addClass('tone-' + view.tone).text(view.badge));
    }
    if (view.title) {
      $head.append($('<span class="pd-status-title"></span>').text(view.title));
    }
    (view.chips || []).forEach(function (chip) {
      $head.append($('<span class="pd-badge"></span>').addClass('tone-' + chip.tone).text(chip.text));
    });
    var $facts = $('<dl class="pd-status-facts"></dl>');
    view.facts.forEach(function (fact) {
      $facts.append($('<dt></dt>').text(fact[0]));
      $facts.append($('<dd></dd>').addClass(fact[0] === 'Error' ? 'pd-status-error' : '').text(fact[1]));
    });
    $status
      .removeClass('tone-info tone-good tone-warn tone-bad tone-muted')
      .addClass('tone-' + view.tone)
      .empty()
      .append($kind)
      .append($head)
      .append(view.facts.length ? $facts : '')
      .show();
  }

  function renderStatus() {
    var choice = selected && findSelected();
    var label = 'Renotify';
    if (choice) {
      paintStatus(choice.kind === 'policy' ? policyView(choice.item) : personView(choice.item));
      if (choice.kind === 'policy' && choice.item.runActive) {
        label = 'Stop';
      }
    } else {
      paintStatus(overviewView());
    }
    $go.text(label).attr('disabled', busy || !choice);
    $select.attr('disabled', busy);
  }

  function renderDetails() {
    $rows.empty();
    policies.forEach(function (item) {
      $rows.append($('<tr></tr>').append($('<td></td>').text(item.text)).append($('<td></td>').text(policyStatus(item))));
    });
    $policiesHeading.toggle(policies.length > 0);
    $table.toggle(policies.length > 0);
    $peopleRows.empty();
    people.forEach(function (person) {
      $peopleRows.append(
        $('<tr></tr>')
          .append($('<td></td>').text(person.text))
          .append($('<td></td>').text(personStatus(person)))
          .append($('<td></td>').text(person.via || ''))
      );
    });
    $peopleHeading.toggle(people.length > 0);
    $peopleTable.toggle(people.length > 0);
  }

  function render() {
    if (!policies.length && !people.length) {
      showMessage('Nobody has been added to this incident yet. Use Add Responders first.');
      return;
    }
    $loading.hide();
    $message.hide();
    $picker.show();
    $details.show();
    renderOptions();
    renderStatus();
    renderDetails();
  }

  function reportError(error) {
    jslog(error);
    g_form.addErrorMessage(error.message || 'Unknown error. Details: ' + JSON.stringify(error));
  }

  function load() {
    var loadedPolicies = policies; // a list that cannot be read keeps what was shown
    var loadedPeople = people;
    var failed = false;
    var outstanding = 2;
    function finished() {
      outstanding--;
      if (outstanding > 0) {
        return;
      }
      policies = loadedPolicies;
      people = loadedPeople;
      if (failed && !policies.length && !people.length) {
        showMessage('Could not load the responders of this incident.');
        return;
      }
      render();
      scheduleRefresh();
    }
    api.listEscalationPolicies(snIncidentId, function (error, data) {
      if (error) {
        failed = true;
        reportError(error);
      } else {
        loadedPolicies = data.items;
      }
      finished();
    });
    api.listResponders(snIncidentId, function (error, data) {
      if (error) {
        failed = true;
        reportError(error);
      } else {
        loadedPeople = data.items;
      }
      finished();
    });
  }

  function perform(call) {
    if (busy) {
      return;
    }
    busy = true;
    renderStatus();
    call(function (error, result) {
      busy = false;
      if (error) {
        reportError(error);
      } else if (result && result.message) {
        g_form.addInfoMessage(result.message);
      }
      refreshesAfterAction = AFTER_ACTION_REFRESHES;
      load();
    });
  }

  function onGo() {
    if (busy) {
      return;
    }
    var choice = selected && findSelected();
    if (!choice) {
      return;
    }
    if (choice.kind === 'policy') {
      perform(function (done) {
        if (choice.item.runActive) {
          api.cancel(choice.item.runId, done);
        } else {
          api.renotify({ snIncidentId: snIncidentId, pdPolicyId: choice.item.id, currentUser: g_user.userID }, done);
        }
      });
    } else {
      // PagerDuty's answer reaches ServiceNow by webhook a few seconds later: say so rather than show the old state
      if (choice.item.state !== 'Pending') {
        awaiting[selected] = choice.item.state;
      }
      perform(function (done) {
        api.renotifyUser({ snIncidentId: snIncidentId, pdUserId: choice.item.id, currentUser: g_user.userID }, done);
      });
    }
  }

  $select.on('change', function () {
    selected = $select.val() || '';
    renderStatus();
  });

  $go.on('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    onGo();
  });

  $('.pd-renotify-form button.submit-cancel').on('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    modal.destroy();
  });

  load();
});
