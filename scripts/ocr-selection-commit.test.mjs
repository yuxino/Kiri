import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createLibraryHarness, nodes } from './helpers/library-render-harness.mjs';
import { capturePanelLayout, captureToolbarPosition } from '../src/windows/toolbar-layout.js';
const source=readFileSync(new URL('../src/windows/OverlayWindow.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('OverlayWindow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);

test('render effects never prepare OCR from a live partial selection',()=>{
 const effects=[];
 const walk=node=>{if(ts.isCallExpression(node)&&node.expression.getText(tree)==='useEffect')effects.push(node.arguments[0]);ts.forEachChild(node,walk)};
 walk(tree);
 for(const effect of effects){
  if(!effect||!ts.isArrowFunction(effect))continue;
  const direct=node=>{
   if(node!==effect&&ts.isFunctionLike(node))return;
   if(ts.isCallExpression(node))assert.notEqual(node.expression.getText(tree),'runOcr','OCR must start from a committed gesture or explicit mode selection, not a render effect');
   ts.forEachChild(node,direct);
  };
  direct(effect);
 }
});
test('pointer release commits its endpoint rather than a stale move frame',()=>{
 const start=source.indexOf('const onPointerUp = useCallback('),end=source.indexOf('function afterSelection',start);
 const handler=source.slice(start,end);
 assert.match(handler,/const committedSelection = normalized\(drag\.start, p\)/);
 assert.match(handler,/isValidSelection\(committedSelection, 3\)/);
 assert.match(handler,/selectionRef\.current = committedSelection/);
 assert.match(handler,/afterSelection\(committedSelection\)/);
 assert.doesNotMatch(handler,/afterSelection\(selectionRef\.current\)/);
});
test('explicit OCR mode switching reuses a finished selection once',()=>{
 const start=source.indexOf('const switchMode = useCallback('),end=source.indexOf('// --- toolbar placement',start);
 const mode=source.slice(start,end);
 assert.match(mode,/void runOcr\(selectionRef\.current\)/);
 assert.match(mode,/\[completionLock, discardPreparedOcr, discardQr, runOcr\]/);
});

test('toolbar OCR is explicit, disabled while completing and independent of screenshot completion', () => {
 const toolbar=source.slice(source.indexOf('const TOOLS:'));
 const harness=createLibraryHarness({}, `import React,{useState,useRef,useEffect,useLayoutEffect} from "react";
  import {t} from "../i18n"; import {KiriIcon} from "../components/KiriIcons";
  const captureToolbarPosition=${captureToolbarPosition.toString()}, capturePanelLayout=${capturePanelLayout.toString()}; ${toolbar}`);
 let recognitions=0,captures=0;
 const component=harness.mount('Toolbar',{selection:{x:100,y:100,width:200,height:100},bounds:{x:0,y:0,width:800,height:600},
  tool:'select',appearance:{},canUndo:false,canRedo:false,canSetSize:false,disabled:false,
  onOcr:()=>recognitions++,onDone:()=>captures++});
 const target=nodes(component.render()).find(node=>node?.props?.title==='Recognize Text');
 assert.ok(target);assert.equal(target.props.icon,'text.viewfinder');
 assert.equal(recognitions,0);target.props.onClick();
 assert.equal(recognitions,1);assert.equal(captures,0);
 const busy=nodes(component.render({selection:{x:100,y:100,width:200,height:100},bounds:{x:0,y:0,width:800,height:600},tool:"select",appearance:{},disabled:true,onOcr:()=>recognitions++})).find(node=>node?.props?.title==='Recognize Text');
 assert.equal(busy.props.disabled,true);
 component.unmount();
});
