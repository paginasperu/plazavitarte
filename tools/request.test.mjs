import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchText } from '../assets/js/request.js';
import { loadProfiles, loadPromos } from '../assets/js/data.js';

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}

test('GET: recupera automáticamente un fallo transitorio y conserva no-cache', async () => {
  let calls = 0; const progress = [];
  await withFetch(async (_, options) => {
    assert.equal(options.cache, 'no-cache');
    return ++calls === 1 ? response('', 503) : response('ok');
  }, async () => assert.equal(await fetchText('test', { onRetry: n => progress.push(n) }), 'ok'));
  assert.equal(calls, 2); assert.deepEqual(progress, [2]);
});

test('GET: un 404 no se reintenta automáticamente', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return response('', 404); }, async () => {
    await assert.rejects(fetchText('test'), /HTTP 404/);
  });
  assert.equal(calls, 1);
});

for (const phase of ['cabeceras', 'cuerpo']) {
  test(`GET: limita y cancela una espera indefinida de ${phase}`, async () => {
    let signal;
    await withFetch(async (_, options) => {
      signal = options.signal;
      if (phase === 'cabeceras') return new Promise(() => {});
      return { ok: true, text: () => new Promise(() => {}) };
    }, async () => await assert.rejects(fetchText('test', { timeout: 20, attempts: 1 }), /Tiempo de espera/));
    assert.equal(signal.aborted, true);
  });
}

test('GET: los errores de red también se recuperan', async () => {
  let calls = 0;
  await withFetch(async () => { if (++calls === 1) throw new TypeError('Failed to fetch'); return response('ok'); }, async () => {
    assert.equal(await fetchText('test'), 'ok');
  });
  assert.equal(calls, 2);
});

test('CSV: rechaza HTML con HTTP 200 en lugar de mostrar resultados falsos', async () => {
  await withFetch(async () => response('<html>error</html>'), async () => {
    await assert.rejects(loadProfiles(), /formato de datos/);
    await assert.rejects(loadPromos(), /formato de datos/);
  });
});

test('CSV: rechaza columnas incompatibles y no inventa datos', async () => {
  await withFetch(async () => response('id,nombre\n1,Ejemplo'), async () => {
    await assert.rejects(loadProfiles(), /formato de datos/);
  });
});
