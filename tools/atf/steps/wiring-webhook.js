var kit = new x_pd_integration.PagerDutyRenotifyTestKit();
var world;
var inserted;

// Inserts a row the way the inbound webhook handling does, which is what the Business Rule listens to
var receive = function (payload) {
  var row = new GlideRecord('x_pd_integration_webhook_import');
  row.initialize();
  row.setValue('message_type', payload.event_type);
  row.setValue('payload', typeof payload === 'string' ? payload : JSON.stringify(payload));
  var id = row.insert();
  if (id) { inserted.push(id); }
  return id;
};

describe('Renotify webhook: the Business Rule feeds the run', function () {
  beforeEach(function () {
    inserted = [];
    world = kit.world();
    world.start();
  });
  afterEach(function () {
    world.cleanup();
    inserted.forEach(function (id) {
      var row = new GlideRecord('x_pd_integration_webhook_import');
      if (row.get(id)) { row.deleteRecord(); }
    });
  });

  it('a responder joining ends the run', function () {
    expect(receive(kit.replyEvent(world.pd.incidentId, 'A', 'joined', world.now() + 1000))).toBeTruthy();
    expect(world.run().getValue('state')).toBe('joined');
    expect(world.run().getValue('active')).toBe('0');
  });

  it('the incident being resolved ends the run', function () {
    receive(kit.resolvedEvent(world.pd.incidentId));
    expect(world.run().getValue('state')).toBe('resolved');
  });

  it('a reply about another incident leaves the run alone', function () {
    receive(kit.replyEvent(world.pd.incidentId + 'X', 'A', 'joined', world.now() + 1000));
    expect(world.run().getValue('state')).toBe('active');
  });

  it('a reply from someone who is not on the current level leaves the run alone', function () {
    receive(kit.replyEvent(world.pd.incidentId, 'B', 'joined', world.now() + 1000));
    expect(world.run().getValue('state')).toBe('active');
  });

  it('other events leave the run alone', function () {
    receive({ event_type: 'incident.acknowledged', data: { id: world.pd.incidentId } });
    expect(world.run().getValue('state')).toBe('active');
  });

  it('a payload that cannot be read does not stop the row from being saved, and leaves the run alone', function () {
    var row = new GlideRecord('x_pd_integration_webhook_import');
    row.initialize();
    row.setValue('message_type', 'incident.responder.replied');
    row.setValue('payload', '{ not json');
    var id = row.insert();
    if (id) { inserted.push(id); }
    expect(id).toBeTruthy();
    expect(world.run().getValue('state')).toBe('active');
  });
});
