import { test, expect } from 'bun:test';
import { registerDecisionImageCapture } from '../../extension-src/entrypoints/background/firefox-bridge.ts';
function fixture({ changedBefore=false, changedAfter=false, revoke=false, images=true, oversized=false, provider='openai-decisions', payload='YQ==' }={}) {
  let handler, captures=0, evaluations=0, statuses=0;
  registerDecisionImageCapture({rpc:{register(_name, fn){handler=fn},async request(){statuses++;return{ready:true,provider,shareImages:images&&!(revoke&&statuses>1)}}},tabIdFromParams:p=>p.tabId,ensureControlledTab(p){if(p.sessionId!=='owned')throw Error('Unowned tab')},getTab:async()=>({url:'https://fixture.test/'}),isBrowserInternalUrl:()=>false,attachTab:async()=>{},requiredSessionId:p=>p.sessionId,sendCdpCommand:async(_tab,method)=>{if(method==='Runtime.evaluate'){evaluations++;return{result:{value:changedBefore||changedAfter&&evaluations>1?'changed':'same-document-state'}};}captures++;return{data:oversized?'a'.repeat(400001):payload};}});
  return {run:()=>handler({tabId:7,sessionId:'owned',pageUrl:'https://fixture.test/',decisionState:'same-document-state'}),unowned:()=>handler({tabId:7,sessionId:'other'}),captures:()=>captures};
}
test('Luna image capture requires current controlled document state and consent',async()=>{const f=fixture();expect(await f.run()).toEqual({image:'data:image/jpeg;base64,YQ=='});expect(f.captures()).toBe(1);await expect(f.unowned()).rejects.toThrow('Unowned');});
test('image sharing disabled or changed page state never captures',async()=>{for(const options of [{images:false},{changedBefore:true}]){const f=fixture(options);expect(await f.run()).toEqual({});expect(f.captures()).toBe(0);}});
test('navigation/state changes, revocation and oversized images discard the capture',async()=>{for(const options of [{changedAfter:true},{revoke:true},{oversized:true}]){const f=fixture(options);expect(await f.run()).toEqual({});expect(f.captures()).toBe(1);}});

test('Jev uses the bounded capture path and rechecks consent after encoding', async () => {
  const bitmap = globalThis.createImageBitmap, canvas = globalThis.OffscreenCanvas;
  const jpeg = Uint8Array.from([255,216,255,192,0,17,8,1,24,1,64,3,1,17,0,2,17,0,3,17,0,255,217]);
  const payload = Buffer.from(jpeg).toString('base64'); let closed = 0;
  globalThis.createImageBitmap = async () => ({width:320,height:280,close(){closed++;}});
  globalThis.OffscreenCanvas = class {
    getContext(){return{drawImage(){}};}
    async convertToBlob(){return new Blob([jpeg],{type:'image/jpeg'});}
  };
  try {
    for (const revoke of [false,true]) {
      const f=fixture({provider:'jev',payload,revoke});
      expect(await f.run()).toEqual(revoke?{}:{image:`data:image/jpeg;base64,${payload}`});
      expect(f.captures()).toBe(1);
    }
    expect(closed).toBe(2);
  } finally {
    if(bitmap===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=bitmap;
    if(canvas===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=canvas;
  }
});
