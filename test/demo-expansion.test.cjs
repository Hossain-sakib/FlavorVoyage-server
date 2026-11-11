const { test } = require('node:test');
const assert = require('node:assert/strict');
const { expandMarketplace } = require('../tools/demo/expand-marketplace.cjs');
test('expansion adds 112 labeled offers without modifying existing records and is idempotent', () => {
  const db = { products: structuredClone(require('../tools/demo/catalog.json')), suppliers: [], orders: [{ id: 'existing-order' }] };
  const before = structuredClone(db);
  assert.equal(expandMarketplace(db), 112);
  assert.equal(db.suppliers.length, 8);
  assert.deepEqual(db.products.slice(0, before.products.length), before.products);
  assert.deepEqual(db.orders, before.orders);
  const added = db.products.slice(before.products.length);
  assert.equal(new Set(added.map(p => p.id)).size, 112);
  for (const p of added) {
    const parent = before.products.find(root => root.id === p.familyId);
    assert.ok(parent);
    assert.equal(p.image, parent.image);
    assert.equal(p.pack, parent.pack);
    assert.equal(p.demoListing, true);
    assert.ok(p.price > 0 && p.moq > 0 && p.stock >= 0);
  }
  assert.equal(expandMarketplace(db), 0);
});
