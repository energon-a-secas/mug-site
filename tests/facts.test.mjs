// The fact readers against the phrasing the owner's own examples use, plus
// the traps a scan would otherwise fall into. Plain node, no install.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCapacityMl, detectStyle, detectMaterial, detectLid, detectCare, mugVerdict, detectFranchise, detectCharacter,
} from '../shared/extract/facts.js';

test('capacity: the owner\'s examples', () => {
  assert.equal(parseCapacityMl('Large 600ml Capacity'), 600);
  assert.equal(parseCapacityMl('Capacity: approx. 475 ml.'), 475);
  assert.equal(parseCapacityMl('Star Wars Ewok 16 oz. Bas Relief Ceramic Mug'), 473);
  assert.equal(parseCapacityMl('3D Sculpted Mug, 20oz | Ceramic, 0.59 Liters'), 590, 'metric wins over the converted imperial');
  assert.equal(parseCapacityMl('Capacity: 32.0 fluid_ounces'), 946);
});

test('capacity: decimal commas, centilitres, litres, and silence', () => {
  assert.equal(parseCapacityMl('Tasse 0,5 l'), 500);
  assert.equal(parseCapacityMl('35 cl'), 350);
  assert.equal(parseCapacityMl('1.2 L stein'), 1200);
  assert.equal(parseCapacityMl('12 fl. oz.'), 355);
  assert.equal(parseCapacityMl('A mug 12 cm tall'), undefined, 'centimetres are not a capacity');
  assert.equal(parseCapacityMl('Set of 2 mugs'), undefined);
  assert.equal(parseCapacityMl('9000 ml tank'), undefined, 'out of range is not a mug');
  assert.equal(parseCapacityMl(''), undefined);
});

test('style: the signal words, strongest first', () => {
  assert.equal(detectStyle('Paladone Astrobot Shaped Mug'), 'shaped');
  assert.equal(detectStyle('DC Comics Joker Head 3D Mug'), 'sculpted');
  assert.equal(detectStyle('South Park Kenny McCormick 3D Sculpted Mug'), 'sculpted');
  assert.equal(detectStyle('Star Wars Ewok 16 oz. Bas Relief Ceramic Mug'), 'relief');
  assert.equal(detectStyle('Sailor Moon Luna Teapot'), 'teapot');
  assert.equal(detectStyle('3D Tiki Mug'), 'tiki', 'tiki outranks 3D');
  assert.equal(detectStyle('Heat Change Mug'), 'printed');
  assert.equal(detectStyle('Pikachu Mug'), 'other', 'silence is other, not printed');
});

test('material, lid and care', () => {
  assert.equal(detectMaterial('Ceramic, 0.59 Liters'), 'ceramic');
  assert.equal(detectMaterial('fine bone china'), 'porcelain');
  assert.equal(detectMaterial('stoneware mug'), 'stoneware');
  assert.equal(detectMaterial('a mug'), undefined);
  assert.equal(detectLid('Versatile lid: multi-way design'), true);
  assert.equal(detectLid('A mug'), undefined, 'silence proves nothing');
  assert.deepEqual(detectCare('Not dishwasher safe. Microwave safe.'), { dishwasherSafe: false, microwaveSafe: true });
  assert.deepEqual(detectCare('Hand wash only, do not microwave'), { dishwasherSafe: false, microwaveSafe: false });
  assert.deepEqual(detectCare('Dishwasher safe'), { dishwasherSafe: true });
});

test('mugVerdict: yes, maybe, no', () => {
  assert.equal(mugVerdict({ name: 'Pikachu 3D Mug' }).verdict, 'yes');
  assert.equal(mugVerdict({ name: 'Sailor Moon Luna Teapot' }).verdict, 'yes');
  assert.equal(mugVerdict({ name: 'Joker Head', productType: 'Mugs' }).verdict, 'yes');
  assert.equal(mugVerdict({ name: 'Mug and Coaster Gift Set' }).verdict, 'maybe');
  assert.equal(mugVerdict({ name: 'Grogu Tumbler' }).verdict, 'maybe');
  assert.equal(mugVerdict({ name: 'Pikachu Plush' }).verdict, 'no');
  assert.equal(mugVerdict({ name: 'Mug Rack for 6 Mugs' }).verdict, 'maybe', 'a rack names mugs and a non-mug');
  assert.equal(mugVerdict({ name: 'Batman Keychain', tags: ['mug'] }).verdict, 'no');
});

test('franchise and character suggestions', () => {
  assert.equal(detectFranchise('ABYSTYLE - Pokemon Pikachu 3D Mug'), 'Pokemon');
  assert.equal(detectFranchise('Pikachu 3D Mug'), 'Pokemon', 'a character names its franchise');
  assert.equal(detectFranchise('DC Comics Joker Head 3D Mug'), 'DC Comics');
  assert.equal(detectFranchise('Paladone Astrobot Shaped Mug PlayStation'), 'Astro Bot', 'narrow before broad');
  assert.equal(detectFranchise('Star Wars Ewok 16 oz. Bas Relief Ceramic Mug'), 'Star Wars');
  assert.equal(detectFranchise('Silver Buffalo South Park Kenny McCormick 3D Sculpted Mug'), 'South Park');
  assert.equal(detectFranchise('Penguin Mug'), null, 'ordinary words are not characters');
  assert.equal(detectFranchise('Pokémon Évoli'), 'Pokemon', 'accents fold');
  assert.equal(detectCharacter('South Park Kenny McCormick 3D Sculpted Mug'), 'Kenny McCormick');
  assert.equal(detectCharacter('Joker Head 3D Mug'), 'Joker');
  assert.equal(detectCharacter('Plain mug'), null);
});

test('styles and franchises the real feeds needed (2026-09-21 run)', () => {
  assert.equal(detectStyle('Death Note - Kira & L Magic Mug'), 'printed', 'a magic mug is a heat-change print');
  assert.equal(detectStyle('Berserk Guts & Griffith Ceramic Coffee Mug'), 'printed');
  assert.equal(detectStyle('Pikachu 3D Coffee Mug'), 'sculpted', 'sculpted is read before printed');
  assert.equal(detectStyle('JUNJI ITO - Slug Girl Mug, 11 oz.'), 'other', 'still honest when nothing says');
  assert.equal(detectFranchise('JUNJI ITO - Slug Girl Mug'), 'Junji Ito');
  assert.equal(detectFranchise('Hatsune Miku Pastel Mug'), 'Hatsune Miku');
  assert.equal(detectFranchise('Hunter x Hunter Killua Coffee Mug'), 'Hunter x Hunter');
  assert.equal(detectCharacter('Hunter x Hunter Killua Coffee Mug'), 'Killua');
  assert.equal(detectFranchise('Dan Da Dan Momo & Okarun Mug'), 'Dan Da Dan');
  assert.equal(detectFranchise('Clorox bleach mug'), null, 'bleach alone is a word, not the anime');
  assert.equal(detectFranchise('Best Friends Mug'), null, 'friends alone is not the sitcom');
  assert.equal(detectFranchise('World Best Boss in the Office Mug'), null);
  assert.equal(detectFranchise('Angel Halo Mug'), null);
  assert.equal(detectFranchise('Berserk Guts & Griffith Ceramic Coffee Mug'), 'Berserk', 'still found through a character');
  assert.equal(detectFranchise('Snoopy Coffee Mug'), 'Peanuts');
});
