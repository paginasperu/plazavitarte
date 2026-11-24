import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, firefox } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRows } from '../assets/js/csv.js';

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]$/, '');
const engine = process.env.BROWSER_ENGINE || "chromium";
let server, browser, base;
let stallBody = false;
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.csv': 'text/csv', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://local');
      const pathname = decodeURIComponent(url.pathname);
      if (pathname === '/' && url.searchParams.has('legacy')) {
        res.setHeader('Content-Type', 'text/html');
        const html = await readFile(resolve(root, 'index.html'), 'utf8');
        res.end(html.replace(/<link id="directoryModule"[\s\S]*?\/\* DIRECTORY_BOOT_END \*\/\s*<\/script>/,
          '<script type="module" src="app.js?v=legacy-html"></script>')); return;
      }
      if (stallBody && pathname === '/data/negocios.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv' });
        res.write('id,nombre,categoria,banner\n'); return;
      }
      const file = resolve(root, pathname.endsWith('/') ? pathname.slice(1) + 'index.html' : pathname.slice(1));
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const options = { headless: true };
  if (process.env.BROWSER_EXECUTABLE) options.executablePath = process.env.BROWSER_EXECUTABLE;
  else if (process.platform === 'win32' && engine === 'chromium') options.channel = 'chrome';
  browser = await ({ chromium, webkit, firefox }[engine]).launch(options);
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(r => server?.close(r)); });

async function pageFor(run, { width = 390, configure = async () => {}, errorsExpected = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768 && engine !== "firefox", hasTouch: width < 768 });
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  try { await configure(page, context); await run(page, context); if (!errorsExpected) assert.deepEqual(errors, [], 'errores JavaScript sin manejar'); }
  finally { await context.close(); }
}
const ready = async page => { await page.locator('#providerGrid article').first().waitFor(); assert.equal(await page.locator('#providerGrid').getAttribute('aria-busy'), 'false'); };
const go = (page, query = '') => page.goto(base + '/' + query, { waitUntil: 'domcontentloaded' });
const cards = page => page.locator('#providerGrid article');

for (const width of [320, 390, 767, 768, 820, 1366]) {
  test(`carga y navegación en ${width}px`, async () => pageFor(async page => {
    await go(page); await ready(page);
    assert.equal(await cards(page).count(), 12);
    assert.equal(await page.locator('#resultsCount').textContent(), '12 negocios');
    assert.equal(await page.locator('#categoryList [data-category]').count(), 12);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('.section-tab[data-view="promos"]').click(); await ready(page);
    assert.ok(await cards(page).count() > 0);
    await page.locator('#categoryList [data-promo-type="Sorteo"]').click();
    assert.ok(page.url().includes('tipo=sorteos'));
    await page.locator('.section-tab[data-view="negocios"]').click();
    assert.equal(await page.locator('#resultsCount').textContent(), '12 negocios');
  }, { width }));
}

test('Negocios aparece aunque Promociones siga pendiente', async () => pageFor(async page => {
  await go(page); await ready(page); assert.equal(await page.locator('#resultsCount').textContent(), '12 negocios');
  await page.locator('.section-tab[data-view="promos"]').click(); assert.equal(await page.locator('#providerGrid').getAttribute('aria-busy'), 'true');
  await page.locator('.section-tab[data-view="negocios"]').click(); await ready(page);
}, { configure: p => p.route('**/data/promociones.csv', () => {}) }));

test('Promociones aparece aunque Negocios siga pendiente', async () => pageFor(async page => {
  await go(page, '?view=promos'); await ready(page); assert.ok(await cards(page).count() > 0);
}, { configure: p => p.route('**/data/negocios.csv', () => {}) }));

test('error transitorio CSV se recupera solo sin recargar', async () => {
  let requests = 0; let documents = 0;
  await pageFor(async page => {
    page.on('request', r => { if (r.isNavigationRequest()) documents++; });
    await go(page); await ready(page); assert.equal(requests, 2); assert.equal(documents, 1);
  }, { configure: p => p.route('**/data/negocios.csv', r => ++requests === 1 ? r.fulfill({ status: 503, body: 'temporario' }) : r.continue()) });
});

test('error persistente termina; reintento recupera sin perder la otra sección', async () => {
  let fail = true; let requests = 0;
  await pageFor(async page => {
    await go(page); await page.locator('#loadError').waitFor({ state: 'visible' }); assert.equal(requests, 3);
    await page.locator('.section-tab[data-view="promos"]').click(); await ready(page);
    await page.locator('.section-tab[data-view="negocios"]').click();
    fail = false; await page.locator('#loadError button').click(); await ready(page);
    assert.equal(await page.locator('#resultsCount').textContent(), '12 negocios');
  }, { configure: p => p.route('**/data/negocios.csv', r => { requests++; return fail ? r.fulfill({ status: 503, body: 'fallo' }) : r.continue(); }) });
});

test('volver a estar online recupera errores automáticamente', async () => {
  let fail = true;
  await pageFor(async page => {
    await go(page); await page.locator('#loadError').waitFor({ state: 'visible' });
    fail = false; await page.evaluate(() => dispatchEvent(new Event('online'))); await ready(page);
  }, { configure: p => p.route('**/data/negocios.csv', r => fail ? r.fulfill({ status: 503, body: 'fallo' }) : r.continue()) });
});

for (const mode of ['abort', 'throw', 'pending']) {
  test(`instalación ${mode} no bloquea el directorio`, async () => pageFor(async page => {
    await go(page); await ready(page); assert.equal(await page.locator('#resultsCount').textContent(), '12 negocios');
    await page.locator('.section-tab[data-view="promos"]').click(); await ready(page);
  }, { errorsExpected: mode === 'throw', configure: p => p.route('**/assets/js/install.js?*', r => mode === 'abort' ? r.abort() : mode === 'throw' ? r.fulfill({ contentType: 'text/javascript', body: 'throw Error("install fault")' }) : undefined) }));
}

test('fuente externa atascada no bloquea ejecución ni tarjetas', async () => pageFor(async page => {
  await go(page); await ready(page);
}, { configure: async p => { await p.unroute('https://fonts.googleapis.com/**'); await p.route('https://fonts.googleapis.com/**', () => {}); } }));

test('sin ResizeObserver: datos, filtros y navegación funcionan', async () => pageFor(async page => {
  await go(page); await ready(page); await page.locator('.section-tab[data-view="promos"]').click(); await ready(page);
}, { configure: p => p.addInitScript(() => { window.ResizeObserver = undefined; }) }));

test('módulo principal interrumpido se recupera automáticamente', async () => {
  let requests = 0;
  await pageFor(async page => { await go(page); await ready(page); assert.ok(requests >= 2); }, {
    configure: p => p.route('**/assets/js/directory.js?*', r => ++requests === 1 ? r.abort() : r.continue())
  });
});

test('módulo principal inalcanzable deja salida visible y recuperable', async () => {
  let fail = true;
  await pageFor(async page => {
    await go(page); await page.locator('#loadError').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.d2-skel').count(), 0);
    fail = false; await page.locator('#loadError button').click(); await ready(page);
  }, { configure: p => p.route('**/assets/js/directory.js?*', r => fail ? r.abort() : r.continue()) });
});

test('URL directa abre ficha sin esperar promociones y permite cerrarla', async () => pageFor(async page => {
  await go(page, '?negocio=1'); await page.locator('#modalDetail').waitFor({ state: 'visible' });
  assert.ok(await page.locator('#modalTitle').textContent());
  await page.locator('#closeDetail').click(); await page.locator('#modalDetail').waitFor({ state: 'hidden' });
}, { configure: p => p.route('**/data/promociones.csv', () => {}) }));

test('búsqueda y vista elegidas mientras carga no se reinician al llegar datos', async () => {
  let release;
  const gate = new Promise(r => release = r);
  await pageFor(async page => {
    await go(page); await page.locator('.section-tab[data-view="promos"]').click();
    await page.locator('#mobileBusinessSearch').fill('oferta'); release(); await ready(page);
    assert.equal(await page.locator('#mobileBusinessSearch').inputValue(), 'oferta');
    assert.equal(await page.locator('.section-tab[data-view="promos"]').getAttribute('aria-current'), 'page');
  }, { configure: p => p.route('**/data/*.csv', async r => { await gate; await r.continue(); }) });
});

test('filtros, búsqueda, fichas e historial', async () => pageFor(async page => {
  await go(page); await ready(page);
  assert.equal(await cards(page).count(), 12);
  await page.locator('#mobileBusinessSearch').fill('zzzznuncaexiste'); await page.locator('#emptyState').waitFor({ state: 'visible' });
  await page.locator('#resetFiltersEmpty').click(); await ready(page);
  await page.locator('[data-category="Belleza"]').click(); assert.ok(page.url().includes('cat=Belleza'));
  await page.locator('#filterToggle').click(); await page.locator('#floorFilter').selectOption('2');
  await page.locator('#closeFilterDrawer').click();
  await go(page); await ready(page);
  const first = page.locator('#providerGrid [data-detail]').first(); const id = await first.getAttribute('data-detail');
  await first.click(); await page.locator('#modalDetail').waitFor({ state: 'visible' }); assert.ok(page.url().includes('negocio=' + id));
  await page.locator('#closeDetail').click(); await page.locator('#modalDetail').waitFor({ state: 'hidden' });
  await page.locator('.section-tab[data-view="promos"]').click(); await page.locator('#categoryList [data-promo-type="Descuento"]').click();
  await page.locator('#filterToggle').click(); await page.locator('#precioFilter').selectOption('200+');
  await page.locator('#closeFilterDrawer').click(); assert.ok(page.url().includes('precio=200%2B'));
  await page.locator('#categoryList [data-promo-type="Sorteo"]').click(); assert.equal(new URL(page.url()).searchParams.has('precio'), false);
  await page.goBack(); assert.equal(new URL(page.url()).searchParams.get('tipo'), 'descuentos');
}));


test('HTML anterior en caché sigue arrancando con los archivos nuevos', async () => pageFor(async page => {
  await go(page, '?legacy'); await ready(page);
  assert.equal(await page.locator('#resultsCount').textContent(), '12 negocios');
}));

test('timeout real de red: no hay espera infinita y las otras vistas siguen disponibles', async () => {
  let release = false; let requests = 0;
  await pageFor(async page => {
    page.setDefaultTimeout(35000);
    await go(page); await page.locator('.section-tab[data-view="promos"]').click(); await ready(page);
    await page.locator('.section-tab[data-view="negocios"]').click();
    await page.locator('#loadError').waitFor({ state: 'visible' });
    assert.equal(requests, 3);
    release = true; await page.locator('#loadError button').click(); await ready(page);
  }, { configure: p => p.route('**/data/negocios.csv', r => { requests++; return release ? r.continue() : undefined; }) });
});

test('timeout real de cuerpo incompleto también cancela y se recupera', async () => {
  stallBody = true;
  try {
    await pageFor(async page => {
      page.setDefaultTimeout(35000); await go(page);
      await page.locator('#loadError').waitFor({ state: 'visible' });
      stallBody = false; await page.locator('#loadError button').click(); await ready(page);
    });
  } finally { stallBody = false; }
});

test('cambios rápidos de sección no duplican solicitudes ni manejadores', async () => {
  let csvRequests = 0;
  await pageFor(async page => {
    page.on('request', r => { if (r.url().includes('.csv')) csvRequests++; });
    await go(page); await ready(page);
    for (let i = 0; i < 12; i++) {
      await page.locator('.section-tab[data-view="promos"]').click();
      await page.locator('.section-tab[data-view="negocios"]').click();
    }
    assert.equal(csvRequests, 2);
    assert.equal(await cards(page).count(), 12);
    assert.equal(await page.locator('body').getAttribute('aria-current'), null);
  });
});


test('ficha abierta se actualiza al llegar las promociones pendientes', async () => {
  let release;
  const gate = new Promise(r => release = r);
  await pageFor(async page => {
    await go(page, '?negocio=1'); await page.locator('#modalDetail').waitFor({ state: 'visible' });
    release(); await page.locator('#modalBody [data-promo]').first().waitFor();
    assert.ok(await page.locator('#modalBody [data-promo]').count() > 0);
  }, { configure: p => p.route('**/data/promociones.csv', async r => { await gate; await r.continue(); }) });
});

test('la llegada tardía de Negocios completa el contacto de una ficha de promoción', async () => {
  let release;
  const gate = new Promise(r => release = r);
  await pageFor(async page => {
    await go(page, '?view=promos'); await ready(page);
    await page.locator('#providerGrid [data-promo]').first().click();
    await page.locator('#modalDetail').waitFor({ state: 'visible' }); release();
    await page.locator('#modalBody .d1-offered-name').waitFor();
    await page.waitForFunction(() => document.querySelector('#modalBody .d1-offered-name')?.textContent.trim());
  }, { configure: p => p.route('**/data/negocios.csv', async r => { await gate; await r.continue(); }) });
});


test('programa principal pendiente agota el plazo y se recupera sin recargar', async () => {
  let fail = true; let requests = 0;
  await pageFor(async page => {
    page.setDefaultTimeout(35000); await go(page);
    await page.locator('#loadError').waitFor({ state: 'visible' });
    assert.equal(requests, 3);
    fail = false; await page.locator('#loadError button').click(); await ready(page);
  }, { configure: p => p.route('**/assets/js/directory.js?*', r => { requests++; return fail ? undefined : r.continue(); }) });
});

test('una descarga antigua que llega tarde no inicializa la app dos veces', async () => {
  let release; let requests = 0; let csvRequests = 0;
  const gate = new Promise(r => release = r);
  await pageFor(async page => {
    page.setDefaultTimeout(15000);
    page.on('request', r => { if (r.url().includes('.csv')) csvRequests++; });
    await go(page); await ready(page); release();
    await page.waitForTimeout(250);
    assert.equal(await cards(page).count(), 12);
    assert.equal(csvRequests, 2);
  }, { configure: p => p.route('**/assets/js/directory.js?*', async r => { if (++requests === 1) await gate; await r.continue(); }) });
});


test('caracteres HTML en datos permanecen como texto y no rompen el render', async () => {
  const attack = '\"><img src=x onerror="window.auditInjection=true">';
  const businesses = parseRows(await readFile(resolve(root, 'data/negocios.csv'), 'utf8'));
  const promos = parseRows(await readFile(resolve(root, 'data/promociones.csv'), 'utf8'));
  for (const row of businesses.slice(1)) {
    row[businesses[0].indexOf('categoria')] = attack;
    row[businesses[0].indexOf('piso')] = attack;
  }
  promos.slice(1).forEach((row, i) => { row[promos[0].indexOf('id')] = attack + i; });
  const csv = rows => rows.map(row => row.map(cell => '"' + cell.replaceAll('"', '""') + '"').join(',')).join('\n');
  await pageFor(async page => {
    await go(page); await ready(page);
    await page.locator('.section-tab[data-view="promos"]').click(); await ready(page);
    assert.equal(await page.evaluate(() => window.auditInjection), undefined);
    assert.equal(await page.locator('img[src="x"]').count(), 0);
  }, { configure: async p => {
    await p.route('**/data/negocios.csv', r => r.fulfill({ contentType: 'text/csv', body: csv(businesses) }));
    await p.route('**/data/promociones.csv', r => r.fulfill({ contentType: 'text/csv', body: csv(promos) }));
  } });
});

test('versión de referencia sigue cargando con el módulo de datos compartido', { skip: 'Vitarte no publica /versions/1/' }, async () => pageFor(async page => {
  await page.goto(base + '/versions/1/', { waitUntil: 'domcontentloaded' });
  await page.locator('#grid article').first().waitFor();
  assert.equal(await page.locator('#grid').getAttribute('aria-busy'), 'false');
}));
test('Vitarte: imágenes, contacto y capturas locales', async () => pageFor(async page => {
  await go(page); await ready(page);
  const failedImages = () => page.evaluate(async () => {
    const images = [...document.querySelectorAll('#providerGrid img')];
    await Promise.allSettled(images.map(img => { img.loading = 'eager'; return img.decode(); }));
    return images.filter(img => !img.naturalWidth).map(img => img.src);
  });
  assert.equal(await cards(page).count(), 12);
  assert.deepEqual(await failedImages(), []);
  assert.equal(await page.locator('footer a[href="https://oficial.pe/"]').count(), 1);
  assert.equal(await page.locator('a[href^="https://wa.me/51950141414?"]').count(), 4);
  if (process.env.VITARTE_CAPTURES) await page.screenshot({ path: resolve(process.env.VITARTE_CAPTURES, 'vitarte-negocios.png'), fullPage: true });
  await page.locator('.section-tab[data-view="promos"]').click(); await ready(page);
  assert.equal(await cards(page).count(), 5);
  assert.deepEqual(await failedImages(), []);
  if (process.env.VITARTE_CAPTURES) await page.screenshot({ path: resolve(process.env.VITARTE_CAPTURES, 'vitarte-promociones.png'), fullPage: true });
}));
