// Shared theme tokens; text-only release notes. Network checks require a click.
module.exports = function createUpdateMenu({root,row,language,setMarkup,request,onOpen,onStateChange}){
 const button=document.createElement('button');button.type='button';button.className='update-trigger';button.id='check-update';
 setMarkup(button,'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12 6a5 5 0 1 0 0 4M12 2v4H8"/></svg><span id="check-update-label"></span><span class="update-hint-badge" id="check-update-badge" hidden><i class="update-hint-dot" aria-hidden="true"></i><span id="check-update-ver"></span></span>');
 row.append(button);
 const dialog=document.createElement('dialog');dialog.id='plugin-update-dialog';dialog.className='update-dialog';
 setMarkup(dialog,'<header><strong id="update-title"></strong><button id="update-close" type="button"></button></header><div class="update-status"><span id="update-icon" aria-hidden="true"></span><strong id="update-status"></strong></div><div class="update-progress"><div class="update-progress-caption"><span id="update-progress-label"></span><span id="update-progress-value"></span></div><div id="update-progress-track" class="update-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i id="update-progress-fill"></i></div></div><dl class="update-versions"><div><dt id="update-current-label"></dt><dd id="update-current"></dd></div><div><dt id="update-latest-label"></dt><dd id="update-latest"></dd></div></dl><section id="update-notes-wrap" hidden><div class="update-notes-head"><h2 id="update-notes-label"></h2><a id="update-notes-link" class="update-notes-link" target="_blank" rel="noopener noreferrer" hidden></a></div><div id="update-notes" class="update-notes"></div></section><footer><span id="update-feedback" role="status"></span><button id="update-action" type="button" hidden></button></footer>');root.append(dialog);
 setMarkup(dialog.querySelector('#update-icon'),'<svg viewBox="0 0 20 20" aria-hidden="true"><path id="update-symbol" d="M15.7 8a6 6 0 1 0-.2 4.5M16 3.5V8h-4.5"/></svg>');
 // A glyph uses the inherited text line box and font metrics, which can exceed
 // the 26px button. Center a fixed-size vector independently of either.
 setMarkup(dialog.querySelector('#update-close'),'<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8"/></svg>');
 const css=document.createElement('style');css.textContent=`
 .update-trigger{display:inline-flex;align-items:center;gap:5px;padding:3px 7px;border:0;border-radius:5px;background:transparent;color:var(--pulse-muted);font:inherit;font-size:11px;line-height:16px;white-space:nowrap;cursor:pointer;flex:none;transition:background-color 120ms ease,color 120ms ease}
 .update-trigger:hover{background:var(--pulse-hover);color:var(--pulse-foreground)}.update-trigger:active{transform:scale(.97)}
 .update-trigger svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round;flex:none}
 .update-hint-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:600;line-height:14px;color:var(--pulse-success);background:color-mix(in srgb,var(--pulse-success) 14%,transparent);border:1px solid color-mix(in srgb,var(--pulse-success) 28%,transparent);font-variant-numeric:tabular-nums}
 .update-hint-badge[hidden]{display:none}
 .update-hint-dot{width:5px;height:5px;border-radius:50%;background:var(--pulse-success);flex:none}
 .update-dialog{width:min(340px,calc(100vw - 32px));box-sizing:border-box;padding:16px;border:1px solid var(--pulse-border);border-radius:12px;background:var(--pulse-card);color:var(--pulse-foreground);box-shadow:0 12px 40px var(--pulse-shadow);font:12px/1.5 var(--pulse-font,-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif)}
 .update-dialog::backdrop{background:rgba(0,0,0,.48)}
 .update-dialog header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.update-dialog header strong{font-size:14px;font-weight:600}
 .update-dialog header button{display:grid;place-items:center;flex:0 0 26px;width:26px;height:26px;min-width:26px;min-height:26px;padding:0;margin:0;border:0;border-radius:6px;background:transparent;color:var(--pulse-muted);line-height:1;appearance:none;cursor:pointer}
 .update-dialog header button:hover{background:var(--pulse-hover);color:var(--pulse-foreground)}
 .update-dialog header button svg{display:block;width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
 .update-status{display:flex;align-items:center;gap:10px;margin:0 0 14px}
 .update-status>span{display:grid;place-items:center;flex:none;width:32px;height:32px;border-radius:8px;background:var(--pulse-hover);color:var(--pulse-accent)}
 .update-status strong{font-size:15px;font-weight:600}
 #update-icon svg{display:block;width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
 #update-icon[data-busy=true] svg{animation:update-spin 900ms linear infinite}#update-icon[data-complete=true] svg{animation:update-settle 220ms cubic-bezier(.23,1,.32,1) both}
 .update-progress{margin:0 0 14px}.update-progress-caption{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;font-size:11px;line-height:16px;color:var(--pulse-muted)}
 #update-progress-label{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#update-progress-value{flex:none;font-variant-numeric:tabular-nums}
 .update-progress-track{position:relative;height:4px;overflow:hidden;border-radius:999px;background:var(--pulse-track)}
 #update-progress-fill{position:absolute;inset:0;border-radius:inherit;background:var(--pulse-accent);transform-origin:left;transform:scaleX(0);transition:transform 260ms cubic-bezier(.23,1,.32,1),opacity 180ms ease;will-change:transform}
 .update-dialog[data-progress=unknown] #update-progress-fill{animation:update-flow 1400ms linear infinite;transition:opacity 180ms ease}
 .update-dialog[data-progress=error] #update-progress-fill{background:var(--pulse-warning);opacity:.65}
 .update-dialog:not([open]) #update-progress-fill{animation-play-state:paused}
 .update-versions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0;padding-top:12px;border-top:1px solid var(--pulse-separator)}
 .update-versions>div{min-width:0}.update-versions dt{color:var(--pulse-muted);font-size:11px;margin-bottom:2px}.update-versions dd{margin:0;font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
 .update-dialog section{padding-top:12px;margin-top:12px;border-top:1px solid var(--pulse-separator)}.update-dialog section[hidden]{display:none}
 .update-notes-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px}
 .update-dialog section h2{font-size:11px;color:var(--pulse-muted);font-weight:500;margin:0}
 .update-notes-link{font-size:11px;color:var(--pulse-accent);text-decoration:none;white-space:nowrap}.update-notes-link:hover{text-decoration:underline}.update-notes-link[hidden]{display:none}
 .update-notes{max-height:200px;overflow:auto;padding-right:4px;font-size:12px;line-height:1.5;word-break:break-word}
 .update-notes ul{margin:0;padding:0;list-style:none;display:grid;gap:6px}
 .update-notes li{position:relative;padding-left:11px;min-width:0}
 .update-notes li::before{content:'•';position:absolute;left:0;color:var(--pulse-muted)}
 .update-notes p{margin:0 0 5px}.update-notes p:last-child{margin-bottom:0}
 .update-notes strong{font-weight:600;color:var(--pulse-foreground)}
 .update-notes code{padding:0 4px;border-radius:4px;background:var(--pulse-hover);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
 .update-notes a{color:var(--pulse-accent);text-decoration:none}.update-notes a:hover{text-decoration:underline}
 .update-dialog footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;padding-top:12px;margin-top:12px;border-top:1px solid var(--pulse-separator)}
 .update-dialog footer span{margin-right:auto;color:var(--pulse-muted);font-size:11px;line-height:1.4}
 .update-dialog footer button{padding:6px 12px;border:1px solid color-mix(in srgb,var(--pulse-accent) 60%,var(--pulse-border));border-radius:7px;background:color-mix(in srgb,var(--pulse-accent) 18%,var(--pulse-card));color:var(--pulse-foreground);font:inherit;font-size:12px;font-weight:550;white-space:nowrap;cursor:pointer}
 .update-dialog footer button[hidden]{display:none}.update-dialog button:active{transform:scale(.97)}
 .update-dialog button:focus-visible,.update-trigger:focus-visible{outline:2px solid var(--pulse-accent);outline-offset:2px}
 @keyframes update-spin{to{transform:rotate(360deg)}}@keyframes update-flow{from{transform:translateX(-38%) scaleX(.38)}to{transform:translateX(100%) scaleX(.38)}}@keyframes update-settle{from{transform:scale(.92);opacity:.45}to{transform:scale(1);opacity:1}}
 @media(prefers-reduced-motion:reduce){.update-dialog[data-progress=unknown] #update-progress-fill{animation:update-breathe 1200ms linear infinite;transform:scaleX(.4)}#update-icon[data-busy=true] svg{animation:update-breathe 1200ms linear infinite}#update-icon[data-complete=true] svg{animation:none}}@keyframes update-breathe{0%,100%{opacity:.45}50%{opacity:1}}
 `;root.append(css);
 const $=id=>dialog.querySelector('#'+id),zh=()=>language.language==='zh-CN'||language.language==='zh-TW',tw=()=>language.language==='zh-TW',w=(cn,en,twText)=>(tw()&&twText!==undefined)?twText:(zh()?cn:en);
 let state={state:'idle'},passiveHint={available:false,latestVersion:null},disposed=false,timer=null,epoch=0,busy=false,lastRender='',meterPhase=null,meterFrame=null,meterRestoreFrame=null;
 function render(){
  const signature=JSON.stringify([language.language,state,passiveHint,busy]);if(signature===lastRender)return;lastRender=signature;
  const triggerText=w('检查更新','Check for updates','檢查更新');
  const clearedByState=['current','installed','reloading'].includes(state.state);
  const hintActive=state.state==='available'||(passiveHint.available&&!clearedByState);
  const hintVersion=(state.state==='available'?state.latestVersion:passiveHint.latestVersion)||null;
  const badge=button.querySelector('#check-update-badge'),verEl=button.querySelector('#check-update-ver');
  if(badge&&verEl){
   badge.hidden=!hintActive;
   verEl.textContent=hintActive?(hintVersion?`v${hintVersion}`:w('新版本','New','新版本')):'';
  }
  if(hintActive)button.setAttribute('data-update-available','true');else button.removeAttribute('data-update-available');
  button.querySelector('#check-update-label').textContent=triggerText;button.setAttribute('aria-label',triggerText);button.title=hintActive&&hintVersion?`${triggerText} · v${hintVersion}`:triggerText;
  $('update-title').textContent=w('插件更新','Plugin update','外掛更新');$('update-close').setAttribute('aria-label',w('关闭','Close','關閉'));
  const status={checking:w('正在检查…','Checking…','正在檢查…'),current:w('已是最新版本','You’re up to date','已是最新版本'),available:w('发现新版本','Update available','發現新版本'),installing:w('正在校验并安装…','Verifying and installing…','正在驗證並安裝…'),installed:w('更新已完成','Update installed','更新已完成'),reloading:w('正在重新加载…','Reloading…','正在重新載入…'),error:w('更新未完成','Update incomplete','更新未完成'),idle:w('检查更新','Check for updates','檢查更新')};
  $('update-status').textContent=status[state.state]||status.error;dialog.setAttribute('aria-busy',String(['checking','installing','reloading'].includes(state.state)));
  renderProgress();
  $('update-current-label').textContent=w('当前版本','Installed','目前版本');$('update-latest-label').textContent=w('最新版本','Latest','最新版本');$('update-current').textContent=state.currentVersion?'v'+state.currentVersion:'—';$('update-latest').textContent=state.latestVersion?'v'+state.latestVersion:'—';
  const textWeight=s=>{let w=0;for(const ch of s)w+=/[\u2e80-\u9fff\uff00-\uffef]/.test(ch)?2:1;return w;};
  const clipInlineNodes=(tokens,maxWeight=84)=>{
   const out=[];let used=0,clipped=false;
   const attachEllipsis=()=>{
    for(let i=out.length-1;i>=0;i--){
     if(out[i].type==='text'||out[i].type==='link'){
      const cleaned=out[i].text.replace(/(?:\s+(?:and|or|with|from|to|the|a|an|of|in|on|at|for|via)|[\s,，、；;:：与及和并从在])+$/i,'');
      if(cleaned){out[i].text=cleaned+'…';return;}
      out.pop();
     }else{out.push({type:'text',text:'…'});return;}
    }
   };
   const pushText=(target,str)=>{
    if(!str||clipped)return false;
    let buf='',lastSafeLen=-1;
    for(const ch of str){
     const isCjk=/[\u2e80-\u9fff\uff00-\uffef]/.test(ch);
     const cw=isCjk?2:1;
     if(used+cw>maxWeight){
      if(!isCjk&&lastSafeLen>=0)buf=buf.slice(0,lastSafeLen);
      clipped=true;break;
     }
     used+=cw;buf+=ch;
     if(isCjk||/\s/.test(ch))lastSafeLen=buf.length;
    }
    if(buf)target.text+=buf;
    return true;
   };
   for(const tok of tokens){
    if(clipped)break;
    if(tok.type==='text'){
     const slot={type:'text',text:''};pushText(slot,tok.text);
     if(slot.text)out.push(slot);
    }else if(tok.type==='link'){
     const slot={type:'link',href:tok.href,text:''};pushText(slot,tok.text);
     if(slot.text)out.push(slot);
    }else if(tok.type==='code'){
     const w=textWeight(tok.text);
     if(used+w<=maxWeight){out.push(tok);used+=w;}
     else{clipped=true;break;}
    }else if(tok.type==='strong'){
     const inner=clipInlineNodes(tok.children,Math.max(16,maxWeight-used));
     if(inner.nodes.length)out.push({type:'strong',children:inner.nodes});
     used+=inner.used;clipped=inner.clipped;
     if(clipped)return {nodes:out,used,clipped};
    }
   }
   if(clipped)attachEllipsis();
   return {nodes:out,used,clipped};
  };
  const parseInlineTokens=(src,allowStrong=true)=>{
   const tokens=[],re=/(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\[([^\]]+)\]\(#[^)\s]*\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`)/g;
   let last=0,m;
   while((m=re.exec(src))){
    if(m.index>last)tokens.push({type:'text',text:src.slice(last,m.index)});
    if(m[2]!==undefined)tokens.push({type:'link',text:m[2],href:m[3]});
    else if(m[4]!==undefined)tokens.push({type:'text',text:m[4]});
    else if(m[5]!==undefined)tokens.push(allowStrong?{type:'strong',children:parseInlineTokens(m[5],false)}:{type:'text',text:m[5]});
    else if(m[6]!==undefined)tokens.push({type:'code',text:m[6]});
    last=m.index+m[0].length;
   }
   if(last<src.length)tokens.push({type:'text',text:src.slice(last)});
   return tokens;
  };
  const renderTokens=(parent,tokens)=>{
   for(const tok of tokens){
    if(tok.type==='text')parent.append(document.createTextNode(tok.text));
    else if(tok.type==='code'){const el=document.createElement('code');el.textContent=tok.text;parent.append(el);}
    else if(tok.type==='strong'){const el=document.createElement('strong');renderTokens(el,tok.children);parent.append(el);}
    else if(tok.type==='link'){const el=document.createElement('a');el.href=tok.href;el.target='_blank';el.rel='noopener noreferrer';el.textContent=tok.text;parent.append(el);}
   }
  };
  const pickNotes=raw=>{
   const sections=[];let current={heading:'',lines:[]};
   for(const line of String(raw||'').split(/\r?\n/).map(l=>l.trim())){
    if(!line||/^---+$/.test(line))continue;
    if(line.startsWith('#')){if(current.lines.length)sections.push(current);current={heading:line.replace(/^#+\s*/,''),lines:[]};}
    else current.lines.push(line);
   }
   if(current.lines.length)sections.push(current);
   const isCjk=s=>/[\u4e00-\u9fff]/.test(s),matchHeading=(s,re)=>re.test(s.heading);
   const changeSec=zh()
    ?(sections.find(s=>matchHeading(s,/更新内容|更新內容/))||sections.find(s=>isCjk(s.heading)&&!/安装|安裝/.test(s.heading)))
    :(sections.find(s=>matchHeading(s,/what.?s?\s*new|what\s+changed|changes/i))||sections.find(s=>!isCjk(s.heading)&&!/install|update\s+or/i.test(s.heading)&&s.lines.some(l=>/^[-*]\s+/.test(l))));
   const rawLines=changeSec?changeSec.lines:sections.flatMap(s=>s.lines);
   const bulletLines=rawLines.filter(line=>/^[-*]\s+/.test(line));
   if(bulletLines.length)return {kind:'list',items:bulletLines.slice(0,4).map(l=>l.replace(/^[-*]\s+/,'').replace(/\s+/g,' ').trim()).filter(Boolean)};
   return {kind:'paragraphs',items:rawLines.slice(0,3).map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean)};
  };
  const picked=pickNotes(state.notes);
  const notesWrap=$('update-notes-wrap'),notesEl=$('update-notes'),notesLink=$('update-notes-link');
  notesWrap.hidden=state.state!=='available'||!picked.items.length;
  $('update-notes-label').textContent=w('更新内容','What’s new','更新內容');
  if(notesLink){
   const verTag=typeof state.latestVersion==='string'&&/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(state.latestVersion)?`tag/v${state.latestVersion}`:'latest';
   notesLink.href=`https://github.com/wycocoyu/agy-context-dashboard/releases/${verTag}`;
   notesLink.textContent=w('更新日志 ↗','Changelog ↗','更新日誌 ↗');
   notesLink.hidden=notesWrap.hidden;
  }
  notesEl.replaceChildren();
  if(!notesWrap.hidden){
   const container=picked.kind==='list'?document.createElement('ul'):null;
   for(const item of picked.items){
    const row=document.createElement(picked.kind==='list'?'li':'p');
    const tokens=parseInlineTokens(item);
    renderTokens(row,clipInlineNodes(tokens,picked.kind==='list'?84:120).nodes);
    (container||notesEl).append(row);
   }
   if(container)notesEl.append(container);
  }
  const errors={network:w('连接失败，请稍后重试','Connection failed. Please retry.','連線失敗，請稍後重試'),python:w('未找到 Python','Python was not found.','找不到 Python'),verification:w('未通过安装包校验','Package verification failed.','安裝套件驗證未通過'),location:w('无法确认插件安装目录，请检查目录位置或链接后重试','Plugin installation location could not be verified. Check its location or links and retry.','無法確認外掛安裝目錄，請檢查目錄位置或連結後重試'),busy:w('已有更新正在进行','Another update is in progress.','已有更新正在進行中'),install:w('未能确认安装完成，请重新检查更新','Installation could not be confirmed. Check for updates again.','未能確認安裝完成，請重新檢查更新'),rollback:w('恢复失败，可从备份恢复','Recovery failed; a local backup is available.','還原失敗，可從本機備份還原')};
  const details={
   timeout:w('连接超时，请检查网络后重试','Connection timed out. Check your network and retry.','連線逾時，請檢查網路後重試'),
   dns:w('无法解析 GitHub 地址，请检查网络','Could not resolve GitHub. Check your network.','無法解析 GitHub 位址，請檢查網路'),
   certificate:w('无法验证下载连接的证书，请检查代理证书','The download certificate could not be verified. Check proxy certificate trust.','無法驗證下載連線憑證，請檢查代理憑證'),
   proxy:w('代理连接失败，请检查代理设置','Proxy connection failed. Check proxy settings.','代理連線失敗，請檢查代理設定'),
   http:w('GitHub 暂时拒绝下载，请稍后重试','GitHub rejected the download. Please retry later.','GitHub 暫時拒絕下載，請稍後重試'),
   connection:w('下载连接中断，请检查网络后重试','Download connection failed. Check your network and retry.','下載連線中斷，請檢查網路後重試'),
   permission:w('插件目录被占用或无写入权限，请关闭其他实例后重试','Plugin files are locked or not writable. Close other instances and retry.','外掛目錄被占用或無寫入權限，請關閉其他執行個體後重試'),
   'python-version':w('需要 Python 3.10 或更新版本','Python 3.10 or newer is required.','需要 Python 3.10 或更新版本'),
   'python-missing':w('未找到可用的 Python，请安装 Python 3.10+','No working Python found. Install Python 3.10+.','找不到可用的 Python，請安裝 Python 3.10+'),
   'install-location':errors.location,
   'plan-expired':w('更新信息已变化或过期，请重新检查更新','Update information changed or expired. Check for updates again.','更新資訊已變更或過期，請重新檢查更新'),
  };
  $('update-feedback').textContent=state.state==='error'?(details[state.errorDetail]||errors[state.error]||errors.network):state.state==='available'?w('设置和统计记录将保留','Settings and statistics are retained','現有設定與統計記錄將會保留'):'';
  const actionable=['available','installed','error'].includes(state.state);$('update-action').hidden=!actionable;$('update-action').disabled=busy;
  $('update-action').textContent=state.state==='installed'?w('重新加载插件','Reload plugin','重新載入外掛'):state.state==='error'?w('重试','Retry','重試'):w('更新','Update','更新');
 }
 function renderProgress(){
  const progress=state.progress||{},phase=progress.phase;
  const complete=['current','available','installed'].includes(state.state),active=['checking','installing','reloading'].includes(state.state);
  const labels={check:w('正在连接发布源','Connecting to releases','正在連線至發布來源'),download:w('正在下载更新','Downloading update','正在下載更新'),verify:w('正在校验安装包','Verifying package','正在驗證安裝套件'),extract:w('正在准备文件','Preparing files','正在準備檔案'),backup:w('正在备份当前版本','Backing up installed version','正在備份目前版本'),install:w('正在安装文件','Installing files','正在安裝檔案'),recover:w('正在恢复原版本','Restoring previous version','正在還原先前版本'),complete:w('更新完成','Update complete','更新完成')};
  const known=state.state==='installing'&&phase==='download'&&Number.isSafeInteger(progress.total)&&progress.total>0&&Number.isSafeInteger(progress.received)&&progress.received>=0&&progress.received<=progress.total;
  const fraction=known?progress.received/progress.total:complete?1:null;
  const nextMeterPhase=state.state+':'+(known?'download':phase||'unknown');
  if(meterPhase!==nextMeterPhase){
   meterPhase=nextMeterPhase;cancelAnimationFrame(meterFrame);cancelAnimationFrame(meterRestoreFrame);
   // A finished check is a different task from a fresh download. Do not
   // animate its 100% backwards into the new download's measured fraction.
   $('update-progress-fill').style.transition='none';
   meterFrame=requestAnimationFrame(()=>{meterRestoreFrame=requestAnimationFrame(()=>{if(!disposed)$('update-progress-fill').style.removeProperty('transition');});});
  }
  let label=labels[phase]||w('正在处理','Working','正在處理中');
  if(state.state==='checking')label=labels.check;
  else if(state.state==='current')label=w('检查完成','Check complete','檢查完成');
  else if(state.state==='available')label=w('准备就绪','Ready to update','準備就緒');
  else if(state.state==='installed')label=labels.complete;
  else if(state.state==='reloading')label=w('正在重新加载插件','Reloading plugin','正在重新載入外掛');
  else if(state.state==='error')label=w('操作未完成，可重试','Not completed. Retry available.','操作未完成，可重試');
  $('update-progress-label').textContent=label;
  $('update-progress-value').textContent=known?`${(progress.received/1048576).toFixed(1)} / ${(progress.total/1048576).toFixed(1)} MB · ${Math.floor(fraction*100)}%`:complete?'100%':'';
  dialog.dataset.progress=state.state==='error'?'error':fraction===null?'unknown':'known';
  const track=$('update-progress-track');track.setAttribute('aria-label',label);
  if(fraction!==null){track.setAttribute('aria-valuenow',String(Math.floor(fraction*100)));$('update-progress-fill').style.transform=`scaleX(${fraction})`;}
  else{track.removeAttribute('aria-valuenow');$('update-progress-fill').style.removeProperty('transform');}
  const icon=$('update-icon');icon.dataset.busy=String(active);icon.dataset.complete=String(complete);
  $('update-symbol').setAttribute('d',complete?'M4.5 10l3.5 3.5 7.5-7.5':'M15.7 8a6 6 0 1 0-.2 4.5M16 3.5V8h-4.5');
 }
 async function call(action){
  const ticket=++epoch;busy=true;if(action==='check')state={...state,state:'checking',progress:{phase:'check'}};if(action==='apply')state={...state,state:'installing',progress:{phase:'verify'}};render();
  try{const result=await request({action,...(action==='apply'?{version:state.latestVersion}:{})});if(disposed||ticket!==epoch)return;if(!result||result.error&&!result.state)throw Error('network');state=result;onStateChange?.(state);}
  catch{if(!disposed&&ticket===epoch)state={...state,state:'error',error:'network'};}
  finally{if(!disposed&&ticket===epoch){busy=false;render();if(['checking','installing'].includes(state.state)){clearTimeout(timer);timer=setTimeout(()=>void call('status'),800);}}}
 }
 button.addEventListener('click',()=>{onOpen?.();dialog.showModal();void call('check');});
 $('update-close').addEventListener('click',()=>{dialog.close();});
 $('update-action').addEventListener('click',()=>void call(state.state==='installed'?'reload':state.state==='error'?'check':'apply'));
 render();return {
  localize:render,
  syncHint(hint){
   const nextAvailable=Boolean(hint?.available),nextVersion=hint?.latestVersion||null;
   if(passiveHint.available===nextAvailable&&passiveHint.latestVersion===nextVersion)return;
   passiveHint={available:nextAvailable,latestVersion:nextVersion};render();
  },
  getState:()=>state,
  dispose(){disposed=true;epoch++;clearTimeout(timer);cancelAnimationFrame(meterFrame);cancelAnimationFrame(meterRestoreFrame);dialog.close();dialog.remove();button.remove();css.remove();}
 };
};
