import { test, expect } from 'bun:test';
import { registerDecisionImageCapture } from '../../extension-src/entrypoints/background/firefox-bridge.js';
function fixture({ changedBefore=false, changedAfter=false, revoke=false, images=true, oversized=false }={}) {
  let handler, captures=0, evaluations=0, statuses=0;
  registerDecisionImageCapture({rpc:{register(_name, fn){handler=fn},async request(){statuses++;return{ready:true,provider:'openai-decisions',shareImages:images&&!(revoke&&statuses>1)}}},tabIdFromParams:p=>p.tabId,ensureControlledTab(p){if(p.sessionId!=='owned')throw Error('Unowned tab')},getTab:async()=>({url:'https://fixture.test/'}),isBrowserInternalUrl:()=>false,attachTab:async()=>{},requiredSessionId:p=>p.sessionId,sendCdpCommand:async(_tab,method)=>{if(method==='Runtime.evaluate'){evaluations++;return{result:{value:changedBefore||changedAfter&&evaluations>1?'changed':'same-document-state'}};}captures++;return{data:oversized?'a'.repeat(400001):'YQ=='};}});
  return {run:()=>handler({tabId:7,sessionId:'owned',pageUrl:'https://fixture.test/',decisionState:'same-document-state'}),unowned:()=>handler({tabId:7,sessionId:'other'}),captures:()=>captures};
}
test('Luna image capture requires current controlled document state and consent',async()=>{const f=fixture();expect(await f.run()).toEqual({image:'data:image/jpeg;base64,YQ=='});expect(f.captures()).toBe(1);await expect(f.unowned()).rejects.toThrow('Unowned');});
test('image sharing disabled or changed page state never captures',async()=>{for(const options of [{images:false},{changedBefore:true}]){const f=fixture(options);expect(await f.run()).toEqual({});expect(f.captures()).toBe(0);}});
test('navigation/state changes, revocation and oversized images discard the capture',async()=>{for(const options of [{changedAfter:true},{revoke:true},{oversized:true}]){const f=fixture(options);expect(await f.run()).toEqual({});expect(f.captures()).toBe(1);}});
