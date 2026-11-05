import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromiumExtensionFixture } from './fixtures/chromium-extension.js';

const fixture = await chromiumExtensionFixture();
try {
  const page = await fixture.context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${fixture.extensionId}/popup.html`);
  await page.getByRole('heading', { name: 'Harness connections' }).waitFor();
  const result = await page.evaluate(async () => ({ manifest: chrome.runtime.getManifest(), status: await chrome.runtime.sendMessage({ type: 'GET_NATIVE_HOST_STATUS' }) }));
  assert.equal(result.manifest.action.default_popup, 'popup.html');
  assert.equal(result.status.status.state, 'connected');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /Storage & cleanup/ }).waitFor();
  await page.getByRole('button', { name: /Local search and models/ }).click();
  await page.waitForSelector('#search-model:not(:disabled)');
  assert.ok(await page.locator('#search-model option').count() > 0);
  await page.getByRole('button', { name: 'Back to settings' }).click();
  await page.getByRole('button', { name: 'Back to Home' }).click();
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#memory-actions')?.textContent !== '—');
  assert.equal(await page.locator('#memory-actions').textContent(), '0');
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  assert.deepEqual(errors, []);
  const background = fixture.context.serviceWorkers()[0] ?? await fixture.context.waitForEvent('serviceworker');
  const before = fixture.context.pages().length;
  const action = await background.evaluate(async () => { try { await chrome.action.openPopup(); return { opened: true }; } catch (error) { return { error: String(error) }; } });
  assert.equal(action.opened, true, action.error);
  assert.equal(fixture.context.pages().length, before, 'toolbar action does not create a regular browser tab');
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(path.join('reports', 'native-popup-check.json'), JSON.stringify({ nativeBridge: result.status.status.state, defaultPopup: result.manifest.action.default_popup, toolbarAction: action, noNewTab: true, pageErrors: errors }, null, 2));
  console.log('Real unpacked extension verified: native bridge connected, settings and models load, memory statistics load, toolbar popup configured, toolbar action opens no regular tab.');
} finally { await fixture.cleanup(); }
