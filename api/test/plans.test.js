import test from 'node:test';
import assert from 'node:assert/strict';
import {exchangeBody,featureDisplay,serializePlans} from '../src/users.js';
const free = {id: 'p1', slug: 'free', name: 'Free', price_inr: '0.00', billing_interval: 'month', is_available: true};
const pro = {id: 'p2', slug: 'pro', name: 'Pro', price_inr: '575.00', billing_interval: 'month', is_available: false};
const row = (plan_id, feature_key, value_type, enabled, config = {}, label = feature_key) =>
  ({plan_id, feature_key, value_type, enabled, config, label});
test('exchangeBody requires a code of sane length and rejects unknown fields', () => {
  assert.equal(exchangeBody.safeParse({}).success, false);
  assert.equal(exchangeBody.safeParse({code: 'short'}).success, false);
  assert.equal(exchangeBody.safeParse({code: 'x'.repeat(101)}).success, false);
  assert.equal(exchangeBody.safeParse({code: 'x'.repeat(43), nope: 1}).success, false);
  assert.equal(exchangeBody.safeParse({code: 'x'.repeat(43)}).success, true);
});
test('featureDisplay words each known feature, including unlimited', () => {
  assert.equal(featureDisplay({key: 'exports', valueType: 'counter', limit: 5}), '5 exports / month');
  assert.equal(featureDisplay({key: 'exports', valueType: 'counter', limit: null}), 'Unlimited exports');
  assert.equal(featureDisplay({key: 'max_shorts', valueType: 'limit', limit: 15}), 'Up to 15 shorts per project');
  assert.equal(featureDisplay({key: 'max_duration', valueType: 'limit', limit: 60}), 'Up to 60 sec per export');
  assert.equal(featureDisplay({key: 'max_duration', valueType: 'limit', limit: 90}), 'Up to 90 sec per export');
  assert.equal(featureDisplay({key: 'max_duration', valueType: 'limit', limit: 180}), 'Up to 3 min per export');
  assert.equal(featureDisplay({key: 'auto_caption', valueType: 'boolean', label: 'Auto-generate captions'}), 'Auto-generate captions');
});
test('featureDisplay falls back to the label for unknown features', () => {
  assert.equal(featureDisplay({key: 'new_thing', valueType: 'limit', label: 'Brand kits', limit: 3}), 'Brand kits: 3');
  assert.equal(featureDisplay({key: 'new_thing', valueType: 'limit', label: 'Brand kits', limit: null}), 'Brand kits: unlimited');
});
test('serializePlans keeps row order, numeric prices, and per-plan features', () => {
  const rows = [
    row('p1', 'exports', 'counter', true, {limit: 5, resetInterval: '1 month'}),
    row('p2', 'exports', 'counter', true, {limit: null}),
    row('p1', 'max_shorts', 'limit', true, {limit: 5}),
    row('p1', 'auto_caption', 'boolean', false, {}, 'Auto-generate captions'),
    row('p2', 'auto_caption', 'boolean', true, {}, 'Auto-generate captions'),
  ];
  const [f, p] = serializePlans([free, pro], rows);
  assert.equal(f.priceInr, 0);
  assert.equal(p.priceInr, 575);
  assert.equal(f.isAvailable, true);
  assert.equal(p.isAvailable, false);
  assert.deepEqual(f.features.map(x => x.key), ['exports', 'max_shorts', 'auto_caption']);
  assert.deepEqual(f.features[0], {key: 'exports', label: 'exports', valueType: 'counter', enabled: true, limit: 5, display: '5 exports / month'});
  assert.equal('limit' in f.features[2], false);
  assert.equal(f.features[2].enabled, false);
  assert.deepEqual(p.features.map(x => x.display), ['Unlimited exports', 'Auto-generate captions']);
});
