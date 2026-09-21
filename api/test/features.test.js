import test from 'node:test';
import assert from 'node:assert/strict';
import {adminPlanBody} from '../src/users.js';
const assetId = '11111111-1111-4111-8111-111111111111';
test('adminPlanBody requires a UUID planId and rejects unknown fields', () => {
  assert.equal(adminPlanBody.safeParse({}).success, false);
  assert.equal(adminPlanBody.safeParse({planId: 'not-a-uuid'}).success, false);
  assert.equal(adminPlanBody.safeParse({planId: assetId, nope: 1}).success, false);
  assert.equal(adminPlanBody.safeParse({planId: assetId}).success, true);
});
