// The current request's host-reported capacity is the occupancy denominator.
// Provider specifications are separately sourced references, never overrides.
const count=value=>(typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
const aliases=new Map([
 ['model_placeholder_m18','Gemini 3 Flash'],
 ['model_placeholder_m21','Gemini 3.1 Flash Image'],
 ['model_placeholder_m50','Gemini 3.1 Flash Lite'],
 ['model_placeholder_m198','Gemini 3.5 Flash Lite'],
 ['model_placeholder_m318','Gemini 3.8 Flash (High)'],
 ['model_placeholder_m319','Gemini 3.8 Flash (Medium)'],
 ['model_placeholder_m320','Gemini 3.8 Flash (Low)'],
 ['model_placeholder_m322','Gemini 3.8 Flash (Tiered)'],
 ['model_placeholder_m400','Claude Opus 5.5 (Low)'],
 ['model_placeholder_m401','Claude Opus 5.5 (Medium)'],
 ['model_placeholder_m402','Claude Opus 5.5 (High)'],
 ['model_placeholder_m403','Claude Sonnet 5.5 (Low)'],
 ['model_placeholder_m404','Claude Sonnet 5.5 (Medium)'],
 ['model_placeholder_m405','Claude Sonnet 5.5 (High)'],
 ['model_placeholder_m417','Gemini 4 Argon (High)'],
 ['model_placeholder_m418','Gemini 4 Argon (Medium)'],
 ['model_placeholder_m419','Gemini 4 Argon (Low)'],
 ['model_placeholder_m427','Gemini 4 Carbon (High)'],
 ['model_placeholder_m437','Gemini 4 Carbon (Medium)'],
 ['model_placeholder_m438','Gemini 4 Carbon (Low)'],
 ['model_placeholder_m525','Gemini 4 Hydrogen (High)'],
 ['model_placeholder_m526','Gemini 4 Hydrogen (Medium)'],
 ['model_placeholder_m527','Gemini 4 Hydrogen (Low)'],
 ['model_placeholder_m528','Gemini 4 Hydrogen (XHigh)'],
 ['model_placeholder_m530','Gemini 4 Hydrogen (High)'],
 ['model_placeholder_m531','Gemini 4 Hydrogen (XHigh)'],
 ['model_placeholder_m532','Gemini 4 Neon (High)'],
 ['model_placeholder_m533','Gemini 4 Neon (Medium)'],
 ['model_placeholder_m534','Gemini 4 Neon (Low)'],
 ['model_placeholder_m535','Gemini 4 Neon (XHigh)'],
 ['model_placeholder_m537','Orchestrator (Neon)'],
 ['model_placeholder_m578','Gemini 4 Hydrogen (Sonar)'],
 ['model_placeholder_m667','Orchestrator (Carbon)'],
 ['model_placeholder_m669','Gemini 4 Hydrogen (Orchestrator)'],
 ['model_placeholder_m681','Orchestrator (Argon)'],
 ['gemini-flash-worker-agy','Gemini 4 Hydrogen (Orchestrator)'],
 ['gemini-pro-orchestrator','Orchestrator (Carbon)'],
 ['gemini-pro-orchestrator-argon','Orchestrator (Argon)'],
 ['gemini-pro-orchestrator-neon','Orchestrator (Neon)'],
 ['model_google_gemini_2_5_flash','Gemini 2.5 Flash'],
 ['model_google_gemini_2_5_flash_lite','Gemini 2.5 Flash Lite'],
 ['model_google_gemini_2_5_flash_thinking','Gemini 2.5 Flash (Thinking)'],
 ['model_google_gemini_2_5_pro','Gemini 2.5 Pro'],
 ['model_placeholder_m35','Claude Sonnet 4.6 (Thinking)'],
 ['model_placeholder_m26','Claude Opus 4.6 (Thinking)'],
 ['model_openai_gpt_oss_120b_medium','GPT-OSS 120B (Medium)'],
 ['model_google_gemini_internal_byom','Gemini (Internal BYOM)'],
 ['gemini-pro-orchestrator-g1-pro','Orchestrator (Argon)'],
]);
const catalogModels=new Map();
const catalogRefs=new Map();
export function resetCatalogModels(){catalogModels.clear();catalogRefs.clear();}
export function registerCatalogModels(response,{checkedAt=new Date().toISOString().slice(0,10)}={}){
 const models=response?.response?.models||response?.models;
 if(!models||typeof models!=='object'||Array.isArray(models))return 0;
 let countRegistered=0;
 for(const [slug,info]of Object.entries(models)){
  if(!info||typeof info!=='object')continue;
  const display=typeof info.displayName==='string'?info.displayName.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,256):'';
  const tokens=count(info.maxTokens);
  if(!display||tokens===null||tokens<=0)continue;
  const key='catalog:'+slug.toLowerCase();
  const entry={key,display};
  catalogRefs.set(key,{tokens,label:tokens.toLocaleString('en-US'),kind:'model-catalog',source:'Antigravity GetAvailableModels',checkedAt});
  catalogModels.set(slug.toLowerCase(),entry);
  if(typeof info.model==='string'&&info.model.trim())catalogModels.set(info.model.trim().toLowerCase(),entry);
  if(!catalogModels.has(display.toLowerCase()))catalogModels.set(display.toLowerCase(),entry);
  countRegistered++;
 }
 return countRegistered;
}
// Placeholder aliases above were checked against the installed host's model
// catalog (M318-M320, M35, M26 on 2026-10-14; M18-M681 on 2026-11-18; M400-M405, M532-M578 on 2026-11-25).
const EFFORT='n|xhigh|extra-high|extrahigh|extra|high|medium|low|max|thinking';
const cap=s=>s[0].toUpperCase()+s.slice(1);
function formatEffort(effort){
 if(!effort||effort==='n')return '';
 const value=effort.toLowerCase();
 if(value==='xhigh'||value==='extra'||value==='extra-high'||value==='extrahigh')return ' (XHigh)';
 return ` (${cap(value)})`;
}
function formatPerplexity(slug){
 const trimmed=slug.replace(/@(?:default|\d{8})(?=$|[-_\s()])/gi,'').trim();
 if(!trimmed)return null;
 const norm=trimmed.toLowerCase().replace(/(\d)[._-](\d)/g,'$1.$2').replace(/[\s()_]+/g,'-').replace(/-+$/,'');
 const effortMatch=norm.match(new RegExp(`^(.+?)-(?:(${EFFORT}))$`));
 const base=effortMatch?effortMatch[1]:norm,effort=effortMatch?formatEffort(effortMatch[2]):'';
 const words=base.split('-').filter(Boolean).map(part=>/^\d+(?:\.\d+)?$/.test(part)?part:cap(part));
 return words.length?`Perplexity ${words.join(' ')}${effort}`:null;
}
function identify(model){
 if(typeof model!=='string')return null;
 const name=model.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,256);
 if(!name)return null;
 const stripped=name.replace(/^word\//i,'');
 const aliased=aliases.get(stripped.toLowerCase())||null;
 const candidate=aliased||stripped;
 if(/^perplexity\//i.test(candidate)){
  const formatted=formatPerplexity(candidate.slice(11));
  if(formatted)return {key:null,display:formatted};
 }
 const normalized=candidate.toLowerCase().replace(/@(?:default|\d{8})(?=$|[-_\s()])/g,'').replace(/(\d)[._-](\d)/g,'$1.$2').replace(/[\s()_]+/g,'-').replace(/-+$/,'');
 let match=normalized.match(/^gemini-3\.8-flash(?:-(n|high|medium|low|tiered))?$/);
 if(match)return {key:'gemini-3.8-flash',display:'Gemini 3.8 Flash'+formatEffort(match[1])};
 match=normalized.match(new RegExp(`^gemini-4-(neon|hydrogen|argon|carbon)(?:-(?:tiered-)?(${EFFORT}|orchestrator|sonar))?$`));
 if(match)return {key:`gemini-4-${match[1]}`,display:`Gemini 4 ${cap(match[1])}`+formatEffort(match[2])};
 match=normalized.match(new RegExp(`^orchestrator-(neon|carbon|argon)(?:-(${EFFORT}))?$`));
 if(match)return {key:`orchestrator-${match[1]}`,display:`Orchestrator (${cap(match[1])})`+formatEffort(match[2])};
 match=normalized.match(new RegExp(`^gemini-3\\.5-flash-lite(?:-(${EFFORT}))?$`));
 if(match)return {key:'gemini-3.5-flash-lite',display:'Gemini 3.5 Flash Lite'+formatEffort(match[1])};
 match=normalized.match(new RegExp(`^gemini-3\\.1-flash-lite(?:-(${EFFORT}))?$`));
 if(match)return {key:'gemini-3.1-flash-lite',display:'Gemini 3.1 Flash Lite'+formatEffort(match[1])};
 if(normalized==='gemini-3.1-flash-image')return {key:'gemini-3.1-flash-image',display:'Gemini 3.1 Flash Image'};
 match=normalized.match(new RegExp(`^gemini-3-flash(?:-(${EFFORT}))?$`));
 if(match)return {key:'gemini-3-flash',display:'Gemini 3 Flash'+formatEffort(match[1])};
 match=normalized.match(new RegExp(`^gemini-2\\.5-(pro|flash-lite|flash)(?:-(${EFFORT}))?$`));
 if(match){const suffix=match[1]==='pro'?'Pro':match[1]==='flash-lite'?'Flash Lite':'Flash';return {key:`gemini-2.5-${match[1]}`,display:`Gemini 2.5 ${suffix}`+formatEffort(match[2])};}
 match=normalized.match(new RegExp(`^claude-(sonnet|opus|haiku)-(4\\.5|4\\.6|4\\.7|4\\.8|5\\.5)(?:-\\d{8})?(?:-(${EFFORT}))?(?:-\\d{8})?$`));
 if(match)return {key:`claude-${match[1]}-${match[2]}`,display:`Claude ${cap(match[1])} ${match[2]}`+formatEffort(match[3])};
 match=normalized.match(new RegExp(`^model-claude-(4\\.5|4\\.6|4\\.7|4\\.8|5\\.5)-(sonnet|opus|haiku)(?:-\\d{8})?(?:-(${EFFORT}))?$`));
 if(match)return {key:`claude-${match[2]}-${match[1]}`,display:`Claude ${cap(match[2])} ${match[1]}`+formatEffort(match[3])};
 match=normalized.match(new RegExp(`^model-claude-(3|3\\.5|3\\.7|4)-(sonnet|opus|haiku)(?:-\\d{8})?(?:-(${EFFORT}))?$`));
 if(match)return {key:null,display:`Claude ${cap(match[2])} ${match[1]}`+formatEffort(match[3])};
 match=normalized.match(/^gpt-oss-120b(?:-(high|medium|low))?$/);
 if(match)return {key:'gpt-oss-120b',display:'GPT-OSS 120B'+formatEffort(match[1])};
 match=normalized.match(new RegExp(`^gpt-6\\.1-sol(?:-(${EFFORT}))?$`));
 if(match)return {key:null,display:'GPT-6.1 Sol'+formatEffort(match[1])};
 match=normalized.match(new RegExp(`^gpt-6-astra(?:-(${EFFORT}))?$`));
 if(match)return {key:null,display:'GPT-6 Astra'+formatEffort(match[1])};
 const fromCatalog=catalogModels.get(stripped.toLowerCase())||catalogModels.get(candidate.toLowerCase());
 if(fromCatalog)return fromCatalog;
 return {key:null,display:aliased||name};
}
export function formatModelName(model){return identify(model)?.display||null;}
export function usageModelKey(model){
 const raw=typeof model==='string'?model.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,120):'';
 return raw?(formatModelName(raw)||raw).slice(0,120):'Unknown';
}
export function modelContextReference(model){
 const key=identify(model)?.key;
 if(!key)return null;
 if(catalogRefs.has(key))return catalogRefs.get(key);
 if(key==='gemini-3.8-flash')return {tokens:1048576,label:'1,048,576',kind:'provider-input-limit',source:'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash',checkedAt:'2026-10-14'};
 if(/^gemini-4-(neon|hydrogen|argon|carbon)$/.test(key))return {tokens:1048576,label:'1,048,576',kind:'provider-context-window',source:`https://aistudio.google.com/docs/models/${key}`,checkedAt:'2026-11-25'};
 if(/^orchestrator-(neon|carbon|argon)$/.test(key))return {tokens:1048576,label:'1,048,576',kind:'model-catalog',source:'Antigravity GetAvailableModels',checkedAt:'2026-11-25'};
 if(/^gemini-(?:3-flash|3\.1-flash-lite|3\.5-flash-lite|2\.5-(?:pro|flash|flash-lite))$/.test(key))return {tokens:1048576,label:'1,048,576',kind:'model-catalog',source:'Antigravity GetAvailableModels',checkedAt:'2026-11-18'};
 if(key==='gemini-3.1-flash-image')return {tokens:65536,label:'65,536',kind:'model-catalog',source:'Antigravity GetAvailableModels',checkedAt:'2026-11-18'};
 if(key==='gpt-oss-120b')return {tokens:131072,label:'131,072',kind:'provider-context-window',source:'https://developers.openai.com/api/docs/models/gpt-oss-120b',checkedAt:'2026-10-14'};
 if(/^claude-(sonnet|opus)-5\.5$/.test(key))return {tokens:1000000,label:'1,000,000',kind:'model-catalog',source:'Antigravity GetAvailableModels',checkedAt:'2026-11-25'};
 if(/^claude-(?:(?:sonnet|opus)-4\.6|opus-4\.[78]|haiku-5\.5)$/.test(key)){
  const legacy=/^claude-(sonnet|opus)-4\.6$/.test(key);
  return {tokens:null,label:'1M',kind:'provider-context-window',source:legacy?`https://platform.claude.com/docs/en/models/${key.slice(7).replace('.', '-')}/overview`:'https://platform.claude.com/docs/en/build-with-claude/context-windows',checkedAt:legacy?'2026-10-14':'2026-11-14'};
 }
 if(/^claude-(sonnet|opus|haiku)-4\.5$/.test(key))return {tokens:null,label:'200K',kind:'provider-context-window',source:'https://platform.claude.com/docs/en/build-with-claude/context-windows',checkedAt:'2026-11-14'};
 return null;
}
export function modelContextCapacity(model){return modelContextReference(model)?.tokens??null;}
export function modelCompressionLimit(_model){
 // The inspected host schema has no compaction-threshold field. Neither the
 // provider's capacity nor the host's maxContextTokens proves a trigger value.
 return null;
}
export function contextMetrics(metadata,{model=null,sampledAt=null}={}){
 if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))return null;
 const usedTokens=count(metadata.estimatedTokensUsed),rawMax=count(metadata.maxContextTokens);
 if(usedTokens===null)return null;
 const reference=modelContextReference(model),providerTokens=count(reference?.tokens);
 const upgraded=rawMax!==null&&rawMax>0&&providerTokens!==null&&providerTokens>rawMax;
 const maxTokens=rawMax>0?(upgraded?providerTokens:rawMax):null;
 return {
  usedTokens,maxTokens,remainingTokens:maxTokens===null?null:Math.max(0,maxTokens-usedTokens),
  usedFraction:maxTokens===null?null:usedTokens/maxTokens,
  remainingFraction:maxTokens===null?null:Math.max(0,1-usedTokens/maxTokens),
  capacitySource:maxTokens===null?null:(upgraded?'model-catalog':'host-reported'),
  hostMaxTokens:rawMax>0?rawMax:null,
  providerMaxTokens:reference?.tokens??null,providerCapacityLabel:reference?.label??null,
  providerCapacitySource:reference?.source??null,providerCapacityKind:reference?.kind??null,
  providerCapacityCheckedAt:reference?.checkedAt??null,
  compressionLimit:null,compressionFraction:null,compressionSource:null,
  model:formatModelName(model),
  sampledAt:typeof sampledAt==='string'&&Number.isFinite(Date.parse(sampledAt))?new Date(sampledAt).toISOString():null,
  source:'Antigravity context window metadata',estimated:true,
 };
}
export function safeContext(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 // Recalculate all derived fields and provider references. Never trust ratios,
 // arbitrary source URLs, unsupported limits or additional saved properties.
 return contextMetrics({estimatedTokensUsed:value.usedTokens,maxContextTokens:value.maxTokens},{model:value.model,sampledAt:value.sampledAt});
}
