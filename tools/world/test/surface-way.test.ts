import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedSurfaceWay } from '../lib/surface-way.ts';

test('underground Kluuvi ways cannot become surface roads or staircase flights', () => {
  for (const tags of [{tunnel:'yes'}, {tunnel:'building_passage'}, {layer:'-1'}, {indoor:'yes'}, {bridge:'yes'}] as Record<string,string>[])
    assert.equal(isSupportedSurfaceWay(tags), false);
});
test('ordinary surface steps, named streets and explicit negative flags remain available', () => {
  for (const tags of [{highway:'steps',incline:'up'}, {highway:'residential',name:'Kaisaniemenkatu'}, {tunnel:'no',bridge:'no',indoor:'no',layer:'0'}] as Record<string,string>[])
    assert.equal(isSupportedSurfaceWay(tags), true);
});
