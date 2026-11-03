import assert from 'node:assert/strict';
import FirefoxRDPClient from '../../node_modules/web-ext/lib/firefox/rdp-client.js';

// Reuse web-ext's loopback debugger for this temporary addon only. WebDriver
// retains its restrictions on privileged URLs and extension execution contexts.
class AddonClient extends FirefoxRDPClient {
  targets = new Map();
  evaluations = new Map();
  async request(message) {
    let timer;
    try {
      return await Promise.race([super.request(message), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Owned addon debugger request timed out')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  _handleMessage(packet) {
    if (packet.type === 'target-available-form') { this.targets.set(packet.target.actor, packet.target); return; }
    if (packet.type === 'target-destroyed-form') { this.targets.delete(packet.target.actor); return; }
    if (packet.type === 'evaluationResult') { this.evaluations.set(packet.resultID, packet); return; }
    // Console/resource lifecycle notifications are not request replies.
    if (packet.type) return;
    super._handleMessage(packet);
  }
}

async function until(read, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(`Timed out waiting for ${label}`);
}

export async function firefoxAddonConsole(port) {
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Owned web-ext debugger port required');
  const client = new AddonClient();
  // Fail pending requests on transport/protocol errors without logging grips
  // or extension URLs from the disposable debugger session.
  client.on('error', () => client.disconnect());
  await client.connect(port);
  try {
    const { addons } = await client.request('listAddons');
    const addonId = 'opencode-browser-plugin@quindart.com';
    const addon = addons.find(item => item.id === addonId && item.temporarilyInstalled);
    assert.ok(addon, 'Only the owned temporary addon may be inspected');
    const watcher = await client.request({ to: addon.actor, type: 'getWatcher' });
    await client.request({ to: watcher.actor, type: 'watchTargets', targetType: 'frame' });
    const target = async suffix => until(() => [...client.targets.values()].find(item => item.addonId === addonId && item.url?.endsWith(suffix)), 'owned addon target');
    const evaluate = async (consoleActor, expression) => {
      const queued = await client.request({ to: consoleActor, type: 'evaluateJSAsync',
        text: `(async()=>JSON.stringify(await (${expression})))()`, mapped: { await: true }, disableBreaks: true });
      const answer = await until(() => client.evaluations.get(queued.resultID), 'addon evaluation');
      client.evaluations.delete(queued.resultID);
      assert.ok(!answer.exception && !answer.topLevelAwaitRejected, 'Owned addon evaluation must succeed');
      assert.equal(typeof answer.result, 'string', 'Fixture results must be bounded JSON primitives');
      return JSON.parse(answer.result);
    };
    const background = await target('/_generated_background_page.html');
    // The extension opens its own page through the supported tabs API.
    await evaluate(background.consoleActor, "browser.tabs.create({url:browser.runtime.getURL('/popup.html#page-panel-fixture'),active:false}).then(()=>true)");
    const popup = await target('/popup.html#page-panel-fixture');
    return {
      evaluate: expression => evaluate(popup.consoleActor, expression),
      close: async () => {
        try {
          // Close extension pages through the extension API too; their BiDi
          // contexts remain protected even after legitimate navigation.
          await evaluate(background.consoleActor, "browser.tabs.query({}).then(tabs=>browser.tabs.remove(tabs.filter(tab=>tab.url?.split(/[?#]/)[0]===browser.runtime.getURL('/popup.html')).map(tab=>tab.id))).then(()=>true)");
        } finally { client.disconnect(); }
      }
    };
  } catch (error) { client.disconnect(); throw error; }
}
