import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FirefoxBackend } from '../../native-host/src/firefox/backend.ts';
import { firefoxAddonConsole } from './firefox-addon-console.js';
import { glassTextContrast } from './glass-contrast.js';

// Called only by the disposable real-extension fixture. No production test hooks.
export async function verifyFirefoxPagePanel({ endpoint, debuggerPort, origin, root, report }) {
  const visual = new FirefoxBackend({ endpoint });
  await visual.connect();
  const existing = new Set((await visual.send('browsingContext.getTree', {})).contexts.map(item => item.context));
  let addon;
  try {
    const page = await visual.send('browsingContext.create', { type: 'tab' });
    await visual.send('browsingContext.navigate', { context: page.context, url: origin + '/glass', wait: 'complete' });
    const evaluate = async (context, expression) => {
      const result = await visual.send('script.evaluate', { target: { context }, expression, awaitPromise: true });
      if (result.type === 'exception') throw Error('Owned fixture evaluation failed: ' + JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    addon = await firefoxAddonConsole(debuggerPort);
    const inPopup = addon.evaluate;
    const tabId = await inPopup(`(async()=>{const t=(await browser.tabs.query({})).find(t=>t.url===${JSON.stringify(origin + '/glass')});return t?.id;})()`);
    assert.equal(typeof tabId, 'number');
    // Capture a reference in this extension's isolated world for automation only.
    // The production renderer still creates a closed shadow root; nothing is
    // installed in the webpage's main world or shipped in extension bundles.
    await inPopup(`browser.scripting.executeScript({target:{tabId:${tabId},frameIds:[0]},func:()=>{const original=Element.prototype.attachShadow;Element.prototype.attachShadow=function(options){const root=original.call(this,options);if(this.id.startsWith('opencode-page-panel-'))globalThis.__ownedPanelRoot=root;return root;};}}).then(()=>true)`);
    const inPanel = expression => inPopup(`browser.scripting.executeScript({target:{tabId:${tabId},frameIds:[0]},func:()=>(${expression})}).then(r=>r[0].result)`);
    const click = async selector => {
      await inPanel(`(globalThis.__ownedPanelRoot.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"nearest"}),true)`);
      const coordinates = JSON.parse(await inPanel(`(()=>{const element=globalThis.__ownedPanelRoot.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing board control');const b=element.getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()`));
      await visual.send('input.performActions', { context: page.context, actions: [{ type: 'pointer', id: 'board-mouse', parameters: { pointerType: 'mouse' }, actions: [
        { type: 'pointerMove', x: coordinates.x, y: coordinates.y, origin: 'viewport' }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }
      ] }] });
    };
    await inPopup(`browser.tabs.update(${tabId},{active:true}).then(()=>true)`);
    const openedResult = await inPopup(`browser.runtime.sendMessage({type:'PAGE_PANEL_OPEN'}).then(r=>JSON.stringify(r))`);
    assert.equal(openedResult,JSON.stringify({ok:true}),'The unmodified packaged renderer must register on a strict-CSP page');
    for(let i=0;i<40;i++){if(await inPanel(`!!globalThis.__ownedPanelRoot?.querySelector('.glass-card')`))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(await inPanel(`!!globalThis.__ownedPanelRoot?.querySelector('.glass-card')`), true);
    assert.equal(await evaluate(page.context, `document.querySelector('[id^="opencode-page-panel-"]').shadowRoot === null`), true);
    assert.equal(await inPanel(`globalThis.__ownedPanelRoot.mode`), 'closed');
    report.checks.push('packaged real extension injects a closed isolated-world board');
    assert.equal(await inPanel(`globalThis.__ownedPanelRoot.querySelector('.board').getAttribute('aria-label')`), 'OpenCode Browser');
    assert.equal(await inPanel(`getComputedStyle(globalThis.__ownedPanelRoot.querySelector('.board')).backdropFilter.includes('blur')`), true);
    const takeShot = async label => {
      const image=await visual.send('browsingContext.captureScreenshot',{context:page.context,origin:'viewport',format:{type:'image/png'}});
      fs.mkdirSync(path.join(root,'reports','page-panel-firefox'),{recursive:true});
      fs.writeFileSync(path.join(root,'reports','page-panel-firefox',label+'.png'),Buffer.from(image.data,'base64'));
    };
    await new Promise(r=>setTimeout(r,2800));
    await takeShot('overview-real-addon');
    for(const view of ['profiles','settings']){
      await click(`#page-tab-${view}`);
      await new Promise(r=>setTimeout(r,100));
      assert.equal(await inPanel(`globalThis.__ownedPanelRoot.querySelector('#page-tab-${view}').getAttribute('aria-selected')`),'true');
      const ratio = await inPanel(`(${glassTextContrast.toString()})(globalThis.__ownedPanelRoot.querySelector('#page-tab-${view} .copy'),[[1,1,1],[233/255,239/255,251/255],[214/255,230/255,251/255]])`);
      assert.ok(ratio >= 4.5, 'Real addon tab label has 4.5:1 composited contrast');
      await takeShot(view+'-real-addon');
    }
    await click('input[type="checkbox"]');
    await new Promise(r=>setTimeout(r,100));
    assert.equal(await inPanel(`globalThis.__ownedPanelRoot.querySelector('.board').classList.contains('opaque')`),true);
    assert.equal(await inPanel(`getComputedStyle(globalThis.__ownedPanelRoot.querySelector('.board')).backdropFilter`),'none');
    report.checks.push('all three real board tabs and opaque-material control');
    const before = await inPopup(`browser.tabs.query({}).then(t=>t.length)`);
    await click('#page-panel-settings button');
    await new Promise(r=>setTimeout(r,500));
    assert.equal(await inPopup(`browser.tabs.query({}).then(t=>t.filter(t=>t.url?.endsWith('/popup.html#settings')).length)`),1);
    assert.equal(await inPopup(`browser.tabs.query({}).then(t=>t.length)`),before+1);
    report.checks.push('settings actions open an actual trusted extension-owned tab');
    assert.equal(await inPanel(`browser.runtime.sendMessage({type:'PAGE_PANEL_OPEN'}).then(r=>r.error==='pagePanelUnavailable')`),true);
    assert.equal(await inPanel(`browser.runtime.sendMessage({type:'GET_DECISION_SETTINGS'}).then(r=>!!r.error)`),true);
    report.checks.push('real content-script sender rejected by privileged popup handlers');
    await inPopup(`browser.tabs.update(${tabId},{active:true}).then(()=>true)`);
    assert.equal(await inPopup(`browser.runtime.sendMessage({type:'PAGE_PANEL_OPEN'}).then(r=>r.ok===true)`),true);
    await new Promise(r=>setTimeout(r,200));
    assert.equal(await evaluate(page.context, `document.querySelectorAll('[id^="opencode-page-panel-"]').length`),1);
    await visual.send('browsingContext.setViewport',{context:page.context,viewport:{width:360,height:800}});
    await new Promise(r=>setTimeout(r,200));
    assert.equal(await inPanel(`(()=>{const r=globalThis.__ownedPanelRoot.host.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width<=innerWidth;})()`),true);
    assert.equal(await inPanel(`globalThis.__ownedPanelRoot.querySelector('.board').classList.contains('opaque')`),true,'Narrow layouts default to solid material for readability');
    await takeShot('overview-narrow-real-addon');
    report.checks.push('idempotent reopening and narrow viewport containment');
    await click('.board-tools button:last-child');
    await new Promise(r=>setTimeout(r,100));
    assert.equal(await evaluate(page.context, `document.querySelectorAll('[id^="opencode-page-panel-"]').length`),0);
    await inPopup(`browser.runtime.sendMessage({type:'PAGE_PANEL_OPEN'}).then(()=>true)`);
    await visual.send('browsingContext.navigate',{context:page.context,url:origin+'/next',wait:'complete'});
    assert.equal(await evaluate(page.context, `document.querySelectorAll('[id^="opencode-page-panel-"]').length`),0);
    report.checks.push('close and full navigation clean up real renderer');
  } finally {
    try {
      const tree = await visual.send('browsingContext.getTree', {});
      for (const item of tree.contexts) if (!existing.has(item.context) && item.url?.startsWith(origin + '/')) await visual.send('browsingContext.close', { context: item.context });
    } finally {
      try { await addon?.close(); } finally { await visual.close(); }
    }
  }
}
