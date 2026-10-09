import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  createHttpServer,
  extractCalculatedBuild,
  parseShareId,
} from '../server.js';

let server;
let baseUrl;

before(async () => {
  server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('share IDs must be numeric and bounded', () => {
  assert.equal(parseShareId('1596110'), '1596110');
  assert.equal(parseShareId(1596110), '1596110');
  assert.throws(() => parseShareId('https://pathbuilder2e.com/launch.html?build=1596110'), /numeric Pathbuilder share ID/);
  assert.throws(() => parseShareId('../1596110'), /numeric Pathbuilder share ID/);
  assert.throws(() => parseShareId('1234567890123'), /numeric Pathbuilder share ID/);
});

test('calculated export must contain a name, class and valid level', () => {
  const valid = { name: 'Kasane', class: 'Champion', level: 7, abilities: { str: 19 } };
  assert.equal(extractCalculatedBuild({ build: valid }), valid);
  assert.throws(() => extractCalculatedBuild({ build: { ...valid, name: '' } }), /missing the character identity/);
  assert.throws(() => extractCalculatedBuild({ build: { ...valid, class: null } }), /missing the character identity/);
  assert.throws(() => extractCalculatedBuild({ build: { ...valid, level: 0 } }), /missing the character identity/);
  assert.throws(() => extractCalculatedBuild({ build: [] }), /missing the character identity/);
});

test('health endpoint returns success without invoking Pathbuilder', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true });
});

test('derive endpoint requires JSON and a numeric share ID', async () => {
  const wrongContentType = await fetch(`${baseUrl}/derive`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(wrongContentType.status, 415);

  const invalidShareId = await fetch(`${baseUrl}/derive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareId: 'https://pathbuilder2e.com/' }),
  });
  assert.equal(invalidShareId.status, 400);
  assert.match((await invalidShareId.json()).error, /numeric Pathbuilder share ID/);
});

test('derive endpoint requires a verified WG session before launching a browser', async () => {
  const response = await fetch(`${baseUrl}/derive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareId: '1596110' }),
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /Sign in to Wanderer’s Guide/);
});
