// A17 in the browser: the mug page's "Suggest a correction" panel and the
// admin's suggestion card. Both render text a collector typed, so both are
// held to escaping here; plain node, no DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { labelValue, suggestionCard } from '../js/admin/suggestions.js';
import { labelsOf, suggestPanel } from '../js/pages/suggest.js';

const EVIL = '<img src=x onerror=alert(1)>';

const MUG = {
  slug: 'joker-head-mug',
  name: `Joker ${EVIL}`,
  brand: { slug: 'abystyle', name: 'ABYstyle' },
  franchise: null,
  character: null,
  style: 'printed',
  capacityMl: 350,
  material: null,
  hasLid: null,
  dishwasherSafe: false,
  microwaveSafe: null,
  releaseYear: null,
  hidden: false,
  suggestion: null,
};

test('the panel asks a visitor to sign in, and never shows on a hidden mug', () => {
  assert.match(suggestPanel(MUG, false), /data-suggest-sign-in/);
  assert.equal(suggestPanel({ ...MUG, hidden: true }, true), '');
});

test("the panel is prefilled with today's labels, escaped, and says when a suggestion waits", () => {
  const html = suggestPanel(MUG, true);
  assert.ok(!html.includes('<img src=x'), 'the name is escaped into the input value');
  assert.match(html, /name="name" value="Joker &lt;img/);
  assert.match(html, /<option value="printed" selected>/);
  assert.match(html, /name="dishwasherSafe"><option value="" >Not known<\/option><option value="true" >Safe<\/option><option value="false" selected>Hand wash only/);
  assert.ok(!html.includes('data-suggest-status'));
  const waiting = suggestPanel({ ...MUG, suggestion: { fields: ['style', 'capacityMl'], createdAt: 1, updatedAt: 1 } }, true);
  assert.match(waiting, /Your suggestion \(Style, Capacity\) is waiting/);
  assert.match(waiting, /<details class="panel" id="suggestPanel" open>/);
});

test('labelsOf reads names out of the objects the mug page gets', () => {
  assert.deepEqual(labelsOf(MUG), {
    name: MUG.name, brand: 'ABYstyle', franchise: null, character: null, style: 'printed', capacityMl: 350,
    material: null, hasLid: null, dishwasherSafe: false, microwaveSafe: null, releaseYear: null,
  });
});

test("the admin's card shows each label now and suggested, escaped, with the note and who sent it", () => {
  const html = suggestionCard({
    id: 'k1',
    createdAt: 1,
    updatedAt: 1,
    note: `Seen at the shop ${EVIL}`,
    mug: { slug: 'joker-head-mug', name: `Joker ${EVIL}`, hidden: false },
    changes: [
      { field: 'style', from: 'printed', to: 'sculpted' },
      { field: 'franchise', from: null, to: `DC ${EVIL}` },
      { field: 'dishwasherSafe', from: false, to: true },
    ],
    by: { handle: 'alice', name: null },
  });
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /<th scope="row">Style<\/th><td>Printed<\/td><td>3D sculpted<\/td>/);
  assert.match(html, /<th scope="row">Franchise<\/th><td><span class="muted">not set<\/span><\/td><td>DC &lt;img/);
  assert.match(html, /<td>Hand wash only<\/td><td>Safe<\/td>/);
  assert.match(html, /From @alice/);
  assert.match(html, /data-reason/);
  assert.equal(labelValue('capacityMl', 450), '450 ml');
  assert.equal(labelValue('hasLid', true), 'Has a lid');
});
