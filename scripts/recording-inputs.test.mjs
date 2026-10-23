import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createLibraryHarness,nodes} from './helpers/library-render-harness.mjs';

const source = 'import React from "react";\n'+readFileSync(new URL('../src/windows/RecordingMicrophoneSelect.tsx',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
const choiceNode=tree=>nodes(tree).find(node=>node?.type==='choice');

test('microphone selection loads on demand, enables the selected input, and preserves recording settings',async()=>{
  const read=deferred(),changes=[];let calls=0;
  const h=createLibraryHarness({listMicrophoneDevices:()=>{calls++;return read.promise;}},source,
    {modules:{'../components/ChoiceSelect':{ChoiceSelect:'choice'}}});
  const props={options:{outputFormat:'mp4',usesCountdown:false,capturesSystemAudio:true,capturesMicrophone:false,showsCursor:true,highlightsClicks:true},disabled:false,onChange:next=>changes.push(next)};
  const c=h.mount('default',props);let menu=choiceNode(c.render());
  assert.equal(calls,0,'no device query until user opens the menu');
  menu.props.onOpen();assert.equal(choiceNode(c.render()).props.menuStatus,'Loading microphones…');
  read.resolve([{id:'usb',name:'USB microphone'}]);await flush();menu=choiceNode(c.render());
  assert.deepEqual(menu.props.options.map(o=>o.value),['','usb']);
  menu.props.onChange('usb');assert.deepEqual(changes[0],{...props.options,usesCountdown:true,capturesMicrophone:true,microphoneDeviceId:'usb'});
  menu.props.onChange('');assert.equal(changes[1].microphoneDeviceId,null);
  c.unmount();
});

test('late microphone enumeration cannot replace a newer list, and missing selections remain explicit',async()=>{
  const requests=[deferred(),deferred()];let calls=0;
  const h=createLibraryHarness({listMicrophoneDevices:()=>requests[calls++].promise},source,
    {modules:{'../components/ChoiceSelect':{ChoiceSelect:'choice'}}});
  const c=h.mount('default',{options:{microphoneDeviceId:'removed'},disabled:false,onChange(){throw new Error('must not silently choose default');}});
  choiceNode(c.render()).props.onOpen();choiceNode(c.render()).props.onOpen();
  requests[1].resolve([{id:'current',name:'Current device'}]);await flush();
  requests[0].resolve([{id:'stale',name:'Old device'}]);await flush();
  const menu=choiceNode(c.render());assert.deepEqual(menu.props.options.map(o=>o.value),['','current']);
  assert.equal(menu.props.value,'removed');assert.equal(menu.props.menuStatus,'Selected microphone is unavailable');c.unmount();
});

test('device menu retains keyboard focus after the focused device disappears and Escape restores its trigger',()=>{
  const changes=[],focused=[];
  const selectSource='import React from "react";\n'+readFileSync(new URL('../src/components/ChoiceSelect.tsx',import.meta.url),'utf8');
  const h=createLibraryHarness({},selectSource,{modules:{'./ChoiceSelect.css':{},'lucide-react':{Check:'check',ChevronDown:'chevron'}},attachRef(node){
    if(node.props.ref && node.props.className?.startsWith('kiri-choice-trigger'))node.props.ref.current={focus(){focused.push('trigger');},getBoundingClientRect(){return {left:250,top:210,bottom:240,width:24};},contains(){return false;}};
    if(node.props.role==='listbox')node.props.ref.current={contains(){return false;},querySelectorAll(){return nodes(node).filter(n=>n?.props?.role==='option').map(n=>({focus(){focused.push(n.props.children[0].props.children[0].props.children[0]);}}));}};
  }});
  h.window.innerWidth=320;h.window.innerHeight=360;
  const props={value:'c',label:'Choose microphone',options:['a','b','c'].map(value=>({value,label:value})),onChange:v=>changes.push(v)};
  const c=h.mount('ChoiceSelect',props);nodes(c.render()).find(n=>n?.props?.['aria-haspopup']==='listbox').props.onClick();
  let tree=c.render();assert.equal(focused.at(-1),'c');
  tree=c.render({...props,options:props.options.slice(0,2)});assert.equal(focused.at(-1),'a');
  let menu=nodes(tree).find(n=>n?.props?.role==='listbox');
  const event=key=>({key,preventDefault(){},stopPropagation(){}});
  menu.props.onKeyDown(event('Enter'));assert.deepEqual(changes,['a']);assert.equal(focused.at(-1),'trigger');
  nodes(c.render()).find(n=>n?.props?.['aria-haspopup']==='listbox').props.onClick();
  menu=nodes(c.render()).find(n=>n?.props?.role==='listbox');menu.props.onKeyDown(event('Escape'));
  assert.equal(focused.at(-1),'trigger');assert.ok(!nodes(c.render()).some(n=>n?.props?.role==='listbox'));c.unmount();
});

test('overlay capture-phase Escape yields to an open microphone menu',()=>{
  const overlay=readFileSync(new URL('../src/windows/OverlayWindow.tsx',import.meta.url),'utf8');
  const code=overlay.slice(overlay.indexOf('    const onEscape = (e: KeyboardEvent) => {'),overlay.indexOf('    window.addEventListener("keydown", onEscape, true);'));
  let cancelled=0,open=true;
  const body=code.replace('const onEscape = (e: KeyboardEvent)', 'const onEscape = (e)')+'return onEscape;';
  const handler=new Function('isTextComposition','document','Element','completionLock','phaseRef','canvasRef','cancel','closeQr',body)(
    ()=>false,{querySelector:()=>open?{}:null},class {},{locked:false},{current:'record-options'},{current:null},()=>cancelled++,()=>{});
  handler({key:'Escape',target:null,preventDefault(){throw new Error('menu must receive escape');},stopImmediatePropagation(){}});
  assert.equal(cancelled,0);open=false;
  handler({key:'Escape',target:null,preventDefault(){},stopImmediatePropagation(){}});assert.equal(cancelled,1);
});

test('a saved microphone is never displayed as the system default before enumeration or after removal',async()=>{
  const read=deferred();let calls=0;
  const h=createLibraryHarness({listMicrophoneDevices:()=>{calls++;return calls===1?read.promise:Promise.reject(new Error('enumeration failed'));}},source,
    {modules:{'../components/ChoiceSelect':{ChoiceSelect:'choice'}}});
  const c=h.mount('default',{options:{microphoneDeviceId:'usb'},disabled:false,onChange(){throw new Error('must not replace the saved selection');}});
  let choice=choiceNode(c.render());
  assert.equal(calls,0);
  assert.equal(choice.props.missingValueLabel,'Choose microphone');
  assert.equal(choice.props.menuStatus,undefined,'no missing-device claim before enumeration');
  choice.props.onOpen();choice=choiceNode(c.render());
  assert.equal(choice.props.missingValueLabel,'Loading microphones…');
  read.resolve([]);await flush();choice=choiceNode(c.render());
  assert.equal(choice.props.value,'usb');
  assert.equal(choice.props.missingValueLabel,'Selected microphone is unavailable');
  assert.equal(choice.props.menuStatus,'Selected microphone is unavailable');
  choice.props.onOpen();await flush();choice=choiceNode(c.render());
  assert.equal(choice.props.missingValueLabel,'Unable to load microphones');
  assert.equal(choice.props.value,'usb');
  c.unmount();
});

test('Tab follows the choice trigger within its modal without selecting a value',()=>{
  const focused=[],changes=[];
  const element=(name,{hidden=false,disabled=false,visibility='visible',tag='button',details=null}={})=>({
    name,tag,visibility,tabIndex:0,focus(){focused.push(name);},
    getClientRects(){return hidden?[]:[{}];},matches(){return disabled;},closest(selector){return selector==='details:not([open])'?details:null;},
  });
  const before=element('before'),after=element('after'),hidden=element('hidden',{hidden:true}),disabled=element('disabled',{disabled:true});
  const invisible=element('invisible',{visibility:'hidden'}),collapsed=element('collapsed',{visibility:'collapse'});
  let candidates,modalActive=true;
  const querySelectorAll=selectors=>candidates.filter(candidate=>selectors.split(',').includes(candidate.tag));
  const modal={querySelectorAll};
  const trigger={...element('trigger'),closest(selector){return selector==="dialog[open], [aria-modal='true']"&&modalActive?modal:null;},getBoundingClientRect(){return {left:10,top:20,bottom:50,width:100};},contains(){return false;}};
  candidates=[before,trigger,hidden,disabled,after];
  const selectSource='import React from "react";\n'+readFileSync(new URL('../src/components/ChoiceSelect.tsx',import.meta.url),'utf8');
  const h=createLibraryHarness({},selectSource,{document:{querySelectorAll},modules:{'lucide-react':{Check:'check',ChevronDown:'chevron'}},attachRef(node){
    if(node.props.ref&&node.props.className?.startsWith('kiri-choice-trigger'))node.props.ref.current=trigger;
    if(node.props.role==='listbox')node.props.ref.current={contains(){return false;},querySelectorAll(){return [{focus(){focused.push('option');}}];}};
  }});
  h.window.innerWidth=800;h.window.innerHeight=600;
  h.window.getComputedStyle=element=>({visibility:element.visibility});
  const c=h.mount('ChoiceSelect',{value:'',label:'Choose microphone',options:[{value:'',label:'System default microphone'}],onChange:value=>changes.push(value)});
  const button=()=>nodes(c.render()).find(n=>n?.props?.['aria-haspopup']==='listbox');
  const tab=(shiftKey=false,shouldPrevent=true)=>{
    button().props.onClick();
    const menu=nodes(c.render()).find(n=>n?.props?.role==='listbox');
    let prevented=false;
    menu.props.onKeyDown({key:'Tab',shiftKey,preventDefault(){prevented=true;},stopPropagation(){}});
    assert.equal(prevented,shouldPrevent);
    assert.ok(!nodes(c.render()).some(n=>n?.props?.role==='listbox'));
  };
  tab();assert.equal(focused.at(-1),'after');
  tab(true);assert.equal(focused.at(-1),'before');
  candidates=[before,trigger,invisible,collapsed,after];
  tab();assert.equal(focused.at(-1),'after','visibility-hidden controls cannot receive focus');
  const details={querySelector(){return summary;},parentElement:null};
  const summary={...element('summary',{tag:'summary',details}),contains(element){return element===this;}};
  const detailsInput=element('closed-details-input',{details});
  candidates=[trigger,summary,detailsInput,after];
  tab();assert.equal(focused.at(-1),'summary','native details summary stays in Tab order');
  candidates=[before,detailsInput,trigger];
  tab(true);assert.equal(focused.at(-1),'before','closed details content is skipped even if it reports a rectangle');
  candidates=[before,trigger];tab();assert.equal(focused.at(-1),'before','Tab wraps inside a modal');
  candidates=[trigger,after];tab(true);assert.equal(focused.at(-1),'after','Shift+Tab wraps inside a modal');
  modalActive=false;candidates=[before,trigger,after];
  tab();assert.equal(focused.at(-1),'after');
  tab(true);assert.equal(focused.at(-1),'before');
  candidates=[trigger];tab(false,false);assert.equal(focused.at(-1),'trigger','document edge uses normal browser Tab navigation');
  assert.deepEqual(changes,[],'leaving a menu never selects its active option');
  c.unmount();
});

test('an absent choice never borrows the first option label',()=>{
  const selectSource='import React from "react";\n'+readFileSync(new URL('../src/components/ChoiceSelect.tsx',import.meta.url),'utf8');
  const h=createLibraryHarness({},selectSource,{modules:{'lucide-react':{Check:'check',ChevronDown:'chevron'}}});
  const props={value:'removed',label:'Choose microphone',missingValueLabel:'Selected microphone is unavailable',options:[{value:'',label:'System default microphone'}],onChange(){}};
  const c=h.mount('ChoiceSelect',props);
  assert.equal(nodes(c.render()).find(n=>n?.props?.['aria-haspopup']==='listbox').props.title,'Selected microphone is unavailable');
  assert.equal(nodes(c.render({...props,options:[...props.options,{value:'removed',label:'USB microphone'}]})).find(n=>n?.props?.['aria-haspopup']==='listbox').props.title,'USB microphone');
  assert.equal(nodes(c.render({...props,value:''})).find(n=>n?.props?.['aria-haspopup']==='listbox').props.title,'System default microphone');
  c.unmount();
});
