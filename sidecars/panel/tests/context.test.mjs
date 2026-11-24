import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextMetrics, safeContext, formatModelName, modelContextReference, modelContextCapacity, modelCompressionLimit, usageModelKey, registerCatalogModels, resetCatalogModels } from '../context.mjs';
import { trajectoryMetrics } from '../metrics.mjs';
import { SessionHistory, safeMetrics } from '../history.mjs';
import { MetricsStore } from '../store.mjs';

const id='11111111-1111-1111-1111-111111111111',scope='a'.repeat(64);
const raw=(used,max=256000,n=1)=>({trajectory:{cascadeId:id,generatorMetadata:Array.from({length:n},(_,i)=>({chatModel:{modelDisplayName:'Model A',usage:{messageId:String(i),inputTokens:'100',responseOutputTokens:'100',apiProvider:'API_PROVIDER_GOOGLE_GEMINI'},streamingDuration:'2s',chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:used,maxContextTokens:max,tokenBreakdown:{prompt:'DO NOT SAVE'}}}}}))}});

test('context is latest request estimate, never accumulated tokens; 0 and over-capacity remain honest',()=>{
  const result=trajectoryMetrics(raw(112000,256000,3));
  assert.equal(result.context.usedTokens,112000);assert.equal(result.context.usedFraction,.4375);
  assert.equal(result.context.remainingTokens,144000);
  assert.equal(contextMetrics({estimatedTokensUsed:0,maxContextTokens:100}).usedFraction,0);
  const over=contextMetrics({estimatedTokensUsed:120,maxContextTokens:100});
  assert.equal(over.usedFraction,1.2);assert.equal(over.remainingTokens,0);
});
test('missing, invalid and unsafe counters cannot produce invented capacities or percentages',()=>{
  for(const estimatedTokensUsed of [-1,Infinity,'wrong',true,{},Number.MAX_SAFE_INTEGER+1])assert.equal(contextMetrics({estimatedTokensUsed,maxContextTokens:100}),null);
  assert.equal(contextMetrics({maxContextTokens:100}),null);
  for(const maxContextTokens of [undefined,0,-1,Infinity,'',true]){
    const value=contextMetrics({estimatedTokensUsed:20,maxContextTokens});
    assert.equal(value.usedTokens,20);assert.equal(value.maxTokens,null);assert.equal(value.usedFraction,null);
  }
});
test('latest model with absent context cannot inherit prior-model capacity',()=>{
  const first=raw(40,100).trajectory.generatorMetadata[0];
  const data=trajectoryMetrics({trajectory:{generatorMetadata:[first,{chatModel:{modelDisplayName:'Model B'}}]}});
  assert.equal(data.context,null);
});
test('only numeric context and sampled model/time enter history; lower usage survives compaction and restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ag-context-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const history=new SessionHistory(directory);
  await history.save(scope,id,trajectoryMetrics(raw(80000,100000,3)));
  await history.save(scope,id,trajectoryMetrics(raw(20000,100000,1)));
  const restored=await new SessionHistory(directory).load(scope,id);
  assert.equal(restored.metrics.context.usedTokens,20000);assert.equal(restored.metrics.requests,3);
  const text=await readFile(history.file(scope,id),'utf8');assert.ok(!text.includes('DO NOT SAVE'));assert.ok(!text.includes('tokenBreakdown'));
  const clean=safeMetrics({...trajectoryMetrics(raw(20,100)),context:{usedTokens:20,maxTokens:100,usedFraction:999,credential:'secret'}},id);
  assert.equal(clean.context.usedFraction,.2);assert.ok(!JSON.stringify(clean).includes('secret'));
});
test('context-only records can persist while old v0.4 records without context still load',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'ag-context-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const history=new SessionHistory(directory);
  const data=trajectoryMetrics({trajectory:{generatorMetadata:[{chatModel:{chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:0,maxContextTokens:100}}}}]}});
  await history.save(scope,id,data);assert.equal((await history.load(scope,id)).metrics.context.usedFraction,0);
  const old=trajectoryMetrics(raw(20));delete old.context;await history.save(scope,id,old);
  assert.equal((await history.load(scope,id)).metrics.tps,50);
});
test('live lower context updates even when cumulative TPS history is protected',async()=>{
  let n=3,used=80;
  const history={load:async()=>null,save:async()=>({savedAt:'2026-10-09T00:00:00Z'})};
  const store=new MetricsStore({trajectory:async()=>raw(used,100,n)},{history});store.identity=scope;
  await store.session(id,true);n=1;used=20;
  const current=await store.session(id,true);
  assert.equal(current.requests,3);assert.equal(current.context.usedFraction,.2);assert.equal(current.contextRestored,false);
});

test('1M model catalog capacities upgrade lower host soft limits while never inferring compaction', () => {
  assert.equal(modelContextCapacity('gemini-3.8-flash-n'), 1048576);
  assert.equal(modelContextCapacity('Gemini 3.8 Flash (High)'), 1048576);
  assert.equal(modelContextReference('Claude Sonnet 5.5 (Thinking)').tokens, 1000000);
  assert.equal(modelContextReference('Claude Opus 5.5 (High)').tokens, 1000000);
  assert.equal(modelContextReference('Claude Sonnet 4.6 (Thinking)').label, '1M');
  assert.equal(modelContextCapacity('Claude Sonnet 4.6 (Thinking)'), null,'Do not invent an exact number from the inspected 1M label');
  assert.equal(modelContextCapacity('GPT-OSS 120B (Medium)'), 131072);
  assert.equal(modelContextCapacity('unknown-model'), null);

  for(const model of ['gemini-3.8-flash-n','MODEL_PLACEHOLDER_M318','MODEL_PLACEHOLDER_M532','MODEL_PLACEHOLDER_M537','MODEL_PLACEHOLDER_M667','claude-sonnet-5.5','claude-sonnet-4-6','gpt-oss-120b'])assert.equal(modelCompressionLimit(model),null);

  assert.equal(formatModelName('gemini-3.8-flash-n'), 'Gemini 3.8 Flash');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M318'), 'Gemini 3.8 Flash (High)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M319'), 'Gemini 3.8 Flash (Medium)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M320'), 'Gemini 3.8 Flash (Low)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M322'), 'Gemini 3.8 Flash (Tiered)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M317'), 'MODEL_PLACEHOLDER_M317');

  const result = contextMetrics(
    { estimatedTokensUsed: 128000, maxContextTokens: 256000 },
    { model: 'gemini-3.8-flash-n' }
  );
  assert.equal(result.usedTokens, 128000);
  assert.equal(result.maxTokens, 1048576);
  assert.equal(result.hostMaxTokens, 256000);
  assert.equal(result.providerMaxTokens,1048576);
  assert.equal(result.capacitySource,'model-catalog');
  assert.equal(result.compressionLimit,null);
  assert.equal(result.usedFraction,128000/1048576);
  assert.equal(result.remainingTokens,1048576-128000);
  assert.equal(result.compressionFraction,null);
  assert.equal(result.model, 'Gemini 3.8 Flash');
});
test('Antigravity 2.35.0 Neon, Orchestrator (Neon), and Claude 5.5 models resolve and upgrade cleanly',()=>{
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M532'),'Gemini 4 Neon (High)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M533'),'Gemini 4 Neon (Medium)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M534'),'Gemini 4 Neon (Low)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M535'),'Gemini 4 Neon (XHigh)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M537'),'Orchestrator (Neon)');
  assert.equal(formatModelName('gemini-pro-orchestrator-neon'),'Orchestrator (Neon)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M578'),'Gemini 4 Hydrogen (Sonar)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M400'),'Claude Opus 5.5 (Low)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M401'),'Claude Opus 5.5 (Medium)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M402'),'Claude Opus 5.5 (High)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M403'),'Claude Sonnet 5.5 (Low)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M404'),'Claude Sonnet 5.5 (Medium)');
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M405'),'Claude Sonnet 5.5 (High)');

  assert.equal(modelContextCapacity('MODEL_PLACEHOLDER_M532'),1048576);
  assert.equal(modelContextCapacity('gemini-4-neon-xhigh'),1048576);
  assert.equal(modelContextCapacity('MODEL_PLACEHOLDER_M537'),1048576);
  assert.equal(modelContextCapacity('MODEL_PLACEHOLDER_M578'),1048576);
  assert.equal(modelContextCapacity('MODEL_PLACEHOLDER_M402'),1000000);
  assert.equal(modelContextCapacity('MODEL_PLACEHOLDER_M405'),1000000);

  const neon=contextMetrics({estimatedTokensUsed:120000,maxContextTokens:512000},{model:'MODEL_PLACEHOLDER_M532'});
  assert.equal(neon.model,'Gemini 4 Neon (High)');
  assert.equal(neon.maxTokens,1048576);
  assert.equal(neon.hostMaxTokens,512000);
  assert.equal(neon.capacitySource,'model-catalog');

  const claude55=contextMetrics({estimatedTokensUsed:200000,maxContextTokens:200000},{model:'MODEL_PLACEHOLDER_M402'});
  assert.equal(claude55.model,'Claude Opus 5.5 (High)');
  assert.equal(claude55.maxTokens,1000000);
  assert.equal(claude55.capacitySource,'model-catalog');
});
test('lower host soft limits upgrade to 1M on known Gemini/Orchestrator models while keeping hostMaxTokens',()=>{
 const result=contextMetrics({estimatedTokensUsed:80000,maxContextTokens:100000},{model:'Gemini 3.8 Flash (High)'});
 assert.equal(result.maxTokens,1048576);assert.equal(result.hostMaxTokens,100000);
 assert.equal(result.usedFraction,80000/1048576);assert.equal(result.remainingTokens,1048576-80000);
 assert.equal(result.providerMaxTokens,1048576);assert.equal(result.capacitySource,'model-catalog');
});
test('equivalent model IDs normalize identically without changing versions or inventing effort',()=>{
 for(const family of ['sonnet','opus'])for(const version of ['4.6','5.5']){
  const dot=`claude-${family}-${version}`,dash=dot.replace('.', '-');
  assert.equal(formatModelName(dot),formatModelName(dash));assert.deepEqual(modelContextReference(dot),modelContextReference(dash));
  assert.ok(!formatModelName(dot).includes('Thinking'));
  assert.match(formatModelName(`Claude ${family} ${version} (Thinking)`),/\(Thinking\)$/);
 }
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M35'),'Claude Sonnet 4.6 (Thinking)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M26'),'Claude Opus 4.6 (Thinking)');
 assert.equal(formatModelName('MODEL_OPENAI_GPT_OSS_120B_MEDIUM'),'GPT-OSS 120B (Medium)');
 assert.equal(formatModelName('gemini-4-hydrogen-xhigh'),'Gemini 4 Hydrogen (XHigh)');
 assert.equal(formatModelName('gemini-4-argon'),'Gemini 4 Argon');
 assert.equal(formatModelName('gemini-4-carbon-high'),'Gemini 4 Carbon (High)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M667'),'Orchestrator (Carbon)');
 assert.equal(formatModelName('gemini-pro-orchestrator'),'Orchestrator (Carbon)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M681'),'Orchestrator (Argon)');
 assert.equal(formatModelName('gemini-pro-orchestrator-g1-pro'),'Orchestrator (Argon)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M669'),'Gemini 4 Hydrogen (Orchestrator)');
 assert.equal(formatModelName('gemini-flash-worker-agy'),'Gemini 4 Hydrogen (Orchestrator)');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M18'),'Gemini 3 Flash');
 assert.equal(formatModelName('MODEL_PLACEHOLDER_M198'),'Gemini 3.5 Flash Lite');
 assert.equal(formatModelName('MODEL_GOOGLE_GEMINI_2_5_PRO'),'Gemini 2.5 Pro');
 assert.equal(formatModelName('gpt-6.1-sol'),'GPT-6.1 Sol');
 assert.equal(formatModelName('word/gpt-6.1-sol'),'GPT-6.1 Sol');
 assert.equal(formatModelName('gpt-6-1-sol-high'),'GPT-6.1 Sol (High)');
 assert.equal(formatModelName('gpt-6-astra-extra'),'GPT-6 Astra (XHigh)');
 assert.equal(modelContextCapacity('Gemini 4 Hydrogen (XHigh)'),1048576);
 assert.equal(modelContextCapacity('gemini-4-argon'),1048576);
 assert.equal(modelContextCapacity('gemini-4-carbon'),1048576);
 assert.equal(modelContextCapacity('MODEL_PLACEHOLDER_M667'),1048576);
 assert.equal(modelContextCapacity('Orchestrator (Carbon)'),1048576);
 assert.equal(modelContextCapacity('Orchestrator (Argon)'),1048576);
 assert.equal(modelContextCapacity('Gemini 4 Hydrogen (Orchestrator)'),1048576);
 assert.equal(modelContextCapacity('Gemini 3 Flash'),1048576);
 assert.equal(modelContextCapacity('Gemini 3.5 Flash Lite'),1048576);
 assert.equal(modelContextCapacity('Gemini 2.5 Pro'),1048576);
 assert.equal(modelContextCapacity('gpt-6.1-sol'),null);
 assert.equal(modelContextReference('gpt-6.1-sol'),null);
 assert.equal(modelContextReference('gpt-6-astra'),null);
 const hydrogen=contextMetrics({estimatedTokensUsed:51643,maxContextTokens:256000},{model:'Gemini 4 Hydrogen (Low)'});
 assert.equal(hydrogen.maxTokens,1048576);assert.equal(hydrogen.hostMaxTokens,256000);assert.equal(hydrogen.providerMaxTokens,1048576);
 assert.equal(Math.round(hydrogen.usedFraction*100),5);
 const orchestrator=contextMetrics({estimatedTokensUsed:250966,maxContextTokens:512000},{model:'MODEL_PLACEHOLDER_M667'});
 assert.equal(orchestrator.model,'Orchestrator (Carbon)');assert.equal(orchestrator.maxTokens,1048576);
 assert.equal(orchestrator.hostMaxTokens,512000);assert.equal(orchestrator.capacitySource,'model-catalog');
 const oneMillion=contextMetrics({estimatedTokensUsed:200000,maxContextTokens:1000000},{model:'gemini-4-hydrogen-xhigh'});
 assert.equal(oneMillion.maxTokens,1048576);assert.equal(oneMillion.hostMaxTokens,1000000);assert.equal(oneMillion.providerMaxTokens,1048576);
});
test('Claude 4.5-5.5, enums, word/*, efforts, Orchestrator, BYOM, Perplexity and tiered Flash normalize safely',()=>{
 for(const family of ['sonnet','opus','haiku']){
  const cap=family[0].toUpperCase()+family.slice(1);
  for(const raw of [`claude-${family}-4-5`,`claude-${family}-4.5`,`claude-${family}-4-5-20250929`,`claude-${family}-4-5@20261114`,`MODEL_CLAUDE_4_5_${family.toUpperCase()}`,`word/claude-${family}-4-5`]){
   assert.equal(formatModelName(raw),`Claude ${cap} 4.5`,raw);
   assert.equal(modelContextReference(raw)?.label,'200K',raw);
   assert.equal(modelContextCapacity(raw),null,raw);
  }
  assert.equal(formatModelName(`MODEL_CLAUDE_4_5_${family.toUpperCase()}_THINKING`),`Claude ${cap} 4.5 (Thinking)`);
  assert.equal(modelContextReference(`MODEL_CLAUDE_4_5_${family.toUpperCase()}_THINKING`)?.label,'200K');
 }
 for(const raw of ['claude-opus-4-7','claude-opus-4.8','word/claude-opus-4-7-max','claude-haiku-5-5','claude-haiku-5.5-extra']){
  assert.equal(modelContextReference(raw)?.label,'1M',raw);
 }
 assert.equal(formatModelName('claude-opus-4-7-max'),'Claude Opus 4.7 (Max)');
 assert.equal(formatModelName('claude-sonnet-5-5-extra-high'),'Claude Sonnet 5.5 (XHigh)');
 assert.equal(formatModelName('claude-sonnet-5-5-extra'),'Claude Sonnet 5.5 (XHigh)');
 assert.equal(formatModelName('claude-sonnet-5-5-n'),'Claude Sonnet 5.5');
 assert.equal(formatModelName('word/claude-sonnet-5-5-medium@default'),'Claude Sonnet 5.5 (Medium)');
 for(const [raw,expected] of [
  ['MODEL_CLAUDE_4_OPUS_THINKING','Claude Opus 4 (Thinking)'],
  ['MODEL_CLAUDE_3_5_SONNET','Claude Sonnet 3.5'],
  ['claude-sonnet-4-7','Claude Sonnet 4.7'],
  ['claude-haiku-4-6','Claude Haiku 4.6'],
  ['MODEL_GOOGLE_GEMINI_INTERNAL_BYOM','Gemini (Internal BYOM)'],
  ['perplexity/fable-5.1','Perplexity Fable 5.1'],
  ['perplexity/sonnet-5-5-high','Perplexity Sonnet 5.5 (High)'],
 ]){
  assert.equal(formatModelName(raw),expected,raw);
  assert.equal(modelContextReference(raw),null,raw);
 }
 assert.equal(formatModelName('gemini-3.8-flash-tiered'),'Gemini 3.8 Flash (Tiered)');
 assert.equal(modelContextCapacity('gemini-3.8-flash-tiered'),1048576);
 assert.equal(formatModelName('word/MODEL_PLACEHOLDER_M318'),'Gemini 3.8 Flash (High)');
 assert.equal(usageModelKey('word/MODEL_PLACEHOLDER_M318'),'Gemini 3.8 Flash (High)');
 assert.equal(modelContextCapacity('word/MODEL_PLACEHOLDER_M318'),1048576);
 assert.equal(formatModelName('word/MODEL_PLACEHOLDER_M26'),'Claude Opus 4.6 (Thinking)');
 assert.equal(modelContextReference('word/MODEL_PLACEHOLDER_M26')?.label,'1M');
 assert.equal(usageModelKey('claude-sonnet-5-5-medium'),'Claude Sonnet 5.5 (Medium)');
 assert.equal(usageModelKey('word/claude-sonnet-5.5-medium@default'),'Claude Sonnet 5.5 (Medium)');
 assert.equal(usageModelKey(' \x00 '),'Unknown');
});
test('live GetAvailableModels registration teaches unknown future models safely',()=>{
 try{
  const n=registerCatalogModels({response:{models:{
   'gemini-5-next':{model:'MODEL_PLACEHOLDER_M999',displayName:'Gemini 5 Next',maxTokens:2097152},
   'internal-no-name':{model:'MODEL_INTERNAL_X',maxTokens:16384},
  }}});
  assert.equal(n,1);
  assert.equal(formatModelName('MODEL_PLACEHOLDER_M999'),'Gemini 5 Next');
  assert.equal(modelContextCapacity('gemini-5-next'),2097152);
  const upgraded=contextMetrics({estimatedTokensUsed:500000,maxContextTokens:512000},{model:'MODEL_PLACEHOLDER_M999'});
  assert.equal(upgraded.maxTokens,2097152);assert.equal(upgraded.capacitySource,'model-catalog');
 }finally{resetCatalogModels();}
 assert.equal(modelContextCapacity('MODEL_PLACEHOLDER_M999'),null);
});
test('metrics and history normalize raw placeholder and wrapped model names',async t=>{
 const result=trajectoryMetrics({trajectory:{cascadeId:id,generatorMetadata:[{chatModel:{model:'MODEL_PLACEHOLDER_M26',chatStartMetadata:{contextWindowMetadata:{estimatedTokensUsed:1000,maxContextTokens:100000}},usage:{messageId:'m1',inputTokens:'10',responseOutputTokens:'10',apiProvider:'API_PROVIDER_ANTHROPIC'}},streamingDuration:'1s'}]}});
 assert.equal(result.model,'Claude Opus 4.6 (Thinking)');
 assert.equal(result.context.providerCapacityLabel,'1M');
 const dir=await mkdtemp(join(tmpdir(),'ag-hist-model-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const history=new SessionHistory(dir);await history.save(scope,id,{...result,model:'word/claude-sonnet-5-5-medium'});
 assert.equal((await history.load(scope,id)).metrics.model,'Claude Sonnet 5.5 (Medium)');
});
test('unknown/family/specialized model names never inherit another model reference',()=>{
 for(const model of ['Gemini','gemini-3.8-flash-tts','gemini-3.8-flash-lite','gemini-4','gemini-4-hydrogen-tts','Claude','claude-sonnet-4','claude-sonnet-5-5-custom','gpt-oss','gpt-oss-20b','gpt-6.1','gpt-6.1-sol-custom','MODEL_PLACEHOLDER_M317','MODEL_PLACEHOLDER_M421','user-gemini-3.8-flash-custom']){
  assert.equal(modelContextReference(model),null,model);assert.equal(formatModelName(model),model);
 }
 for(const model of [undefined,null,123,'',' \n\t'])assert.equal(modelContextReference(model),null);
});
test('known provider capacity cannot fabricate a missing, zero or invalid host denominator',()=>{
 for(const maxContextTokens of [undefined,0,-1,Infinity,'',true,{},Number.MAX_SAFE_INTEGER+1]){
  const value=contextMetrics({estimatedTokensUsed:20,maxContextTokens},{model:'Gemini 3.8 Flash (High)'});
  assert.equal(value.maxTokens,null);assert.equal(value.usedFraction,null);assert.equal(value.providerMaxTokens,1048576);
 }
});
test('saved derived fields and arbitrary reference/threshold data are never trusted',()=>{
 const value=safeContext({usedTokens:80000,maxTokens:100000,model:'Gemini 3.8 Flash (High)',usedFraction:.01,remainingTokens:999999,
  providerMaxTokens:999999999,providerCapacityLabel:'PRIVATE',providerCapacitySource:'https://example.com/private',compressionLimit:200000,compressionFraction:4,credential:'secret',breakdown:{private:'PRIVATE'}});
 assert.equal(value.maxTokens,1048576);assert.equal(value.usedFraction,80000/1048576);assert.equal(value.remainingTokens,1048576-80000);assert.equal(value.providerMaxTokens,1048576);
 assert.equal(value.compressionLimit,null);assert.equal(value.compressionFraction,null);assert.ok(!JSON.stringify(value).includes('PRIVATE'));assert.ok(!JSON.stringify(value).includes('secret'));
 assert.equal(safeContext({usedTokens:Infinity,maxTokens:100}),null);
});
test('provider reference and unknown threshold survive numeric history round trips',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'ag-context-reference-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const history=new SessionHistory(directory),response=raw(128000,256000);
 response.trajectory.generatorMetadata[0].chatModel.modelDisplayName='Gemini 3.8 Flash (High)';
 await history.save(scope,id,trajectoryMetrics(response));const restored=(await history.load(scope,id)).metrics.context;
 assert.equal(restored.usedFraction,128000/1048576);assert.equal(restored.maxTokens,1048576);assert.equal(restored.providerMaxTokens,1048576);assert.equal(restored.compressionLimit,null);
 const saved=JSON.parse(await readFile(history.file(scope,id),'utf8'));assert.equal(saved.metrics.context.providerCapacitySource,'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash');
});
