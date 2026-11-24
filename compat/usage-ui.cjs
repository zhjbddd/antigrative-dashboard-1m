// Shared local usage views. Values and model labels are inserted as text.
module.exports = function createUsageDashboard({root,language,setMarkup,pricing=window.__agPulsePricingFactory?.(),hostLabel='Antigravity',guideDismissed=false,onDismissGuide,onLanguage,onRefresh,onScope}) {
  if(!pricing)throw new Error('Pricing helper is required for usage dashboard');
  const dialog=document.createElement('dialog');dialog.id='usage-dashboard';dialog.setAttribute('popover','manual');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label',language.language==='zh-TW'?'用量統計':language.language==='zh-CN'?'用量统计':'Token usage');
  dialog.style.cssText='width:min(1040px,calc(100vw - 40px));max-width:none;height:min(840px,calc(100dvh - 40px));max-height:none;box-sizing:border-box;overflow:hidden;visibility:visible;pointer-events:auto;padding:0;border:1px solid var(--pulse-border);border-radius:14px;background:var(--pulse-background);color:var(--pulse-foreground);box-shadow:0 16px 60px var(--pulse-shadow);';
  const shell=document.createElement('div'),view=shell.attachShadow({mode:'open'});shell.style.height='100%';dialog.append(shell);root.append(dialog);
  const backdrop=document.createElement('style');backdrop.textContent='#usage-dashboard{position:fixed;inset:0;margin:auto}#usage-dashboard::backdrop{background:rgba(0,0,0,.48);pointer-events:auto}';root.append(backdrop);
  const css=document.createElement('style');css.textContent=`
    :host{display:block;height:100%;color:var(--pulse-foreground);font:13px/1.5 var(--pulse-font,-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif);font-variant-numeric:tabular-nums}
    *{box-sizing:border-box}button,select{font:inherit;color:inherit}button{cursor:pointer}button,select{border:1px solid var(--pulse-border);background:transparent;border-radius:7px}button{transition:background 140ms ease,transform 120ms cubic-bezier(.23,1,.32,1)}button:active{transform:scale(.97)}button:focus-visible,select:focus-visible{outline:2px solid var(--pulse-accent);outline-offset:3px}button[disabled]{opacity:.35;cursor:default}
    .page{height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--pulse-background)}
    .page-head{flex:none;padding:16px 24px 0;background:var(--pulse-background);z-index:3}
    .page-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;margin-right:4px;padding:0 14px 14px 24px;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;overflow-anchor:none}.page-body>*{flex:none}
    .page-body::-webkit-scrollbar,.heat-wrap::-webkit-scrollbar,.chart-wrap::-webkit-scrollbar,.table-wrap::-webkit-scrollbar,.legend::-webkit-scrollbar,.year-menu::-webkit-scrollbar{width:6px;height:6px}
    .page-body::-webkit-scrollbar-button,.heat-wrap::-webkit-scrollbar-button,.chart-wrap::-webkit-scrollbar-button,.table-wrap::-webkit-scrollbar-button,.legend::-webkit-scrollbar-button,.year-menu::-webkit-scrollbar-button{display:none;width:0;height:0}
    .page-body::-webkit-scrollbar-track,.heat-wrap::-webkit-scrollbar-track,.chart-wrap::-webkit-scrollbar-track,.table-wrap::-webkit-scrollbar-track,.legend::-webkit-scrollbar-track,.year-menu::-webkit-scrollbar-track{background:transparent;margin:6px 0}
    .page-body::-webkit-scrollbar-thumb,.heat-wrap::-webkit-scrollbar-thumb,.chart-wrap::-webkit-scrollbar-thumb,.table-wrap::-webkit-scrollbar-thumb,.legend::-webkit-scrollbar-thumb,.year-menu::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--pulse-muted) 28%,transparent);border-radius:999px}
    .page-body::-webkit-scrollbar-thumb:hover,.heat-wrap::-webkit-scrollbar-thumb:hover,.chart-wrap::-webkit-scrollbar-thumb:hover,.table-wrap::-webkit-scrollbar-thumb:hover,.legend::-webkit-scrollbar-thumb:hover,.year-menu::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--pulse-muted) 48%,transparent)}
    .top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}h1{font-size:19px;letter-spacing:-.4px;line-height:1.25;margin:0 0 3px;font-weight:600}.sub{font-size:12px;color:var(--pulse-muted)}.actions{display:flex;gap:8px;align-items:center}.actions button{display:grid;place-items:center;flex:0 0 32px;width:32px;height:32px;padding:0;line-height:1;border-radius:8px;color:var(--pulse-muted)}.actions button:hover{background:var(--pulse-hover);color:var(--pulse-foreground)}.actions svg{display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}.locale-label{display:block;min-width:16px;height:16px;line-height:16px;text-align:center;font-size:11px}.live-dot{display:inline-block;width:5px;height:5px;background:var(--pulse-success);border-radius:50%;margin-right:6px}
    .tabs-bar{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;border-bottom:1px solid var(--pulse-separator);margin:10px 0 0}.tabs{display:flex;gap:22px;border-bottom:0;margin:0}.tabs button{border:0;border-radius:0;background:transparent;color:var(--pulse-muted);padding:0 2px 10px;position:relative;font-size:13px}.tabs button[aria-selected=true]{color:var(--pulse-foreground);font-weight:600}.tabs button[aria-selected=true]:after{content:'';position:absolute;height:2px;background:var(--pulse-accent);bottom:-1px;left:0;right:0}
    .totals{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border-bottom:1px solid var(--pulse-separator);padding:11px 0;margin-bottom:14px}.metric{padding:0 12px;min-width:0}.metric:first-child{padding-left:0}.metric:last-child{padding-right:0}.metric+.metric{border-left:1px solid var(--pulse-separator)}.metric label{display:block;color:var(--pulse-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.value{font-size:18px;letter-spacing:-.5px;line-height:1.25;margin:2px 0 0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.unit{font-size:10.5px;color:var(--pulse-muted);margin-left:4px;font-weight:400;letter-spacing:0}.approx{font-weight:450;opacity:.68;margin-right:1px}
    section[hidden]{display:none}.section-head{display:flex;align-items:center;justify-content:space-between;gap:15px;margin:0 0 10px}h2{font-size:14px;font-weight:600;letter-spacing:-.2px;margin:0}.detail-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px}.muted{font-size:11px;color:var(--pulse-muted)}.seg{display:flex;padding:3px;background:var(--pulse-hover);border-radius:8px;gap:2px}.seg button{border:0;padding:4px 12px;border-radius:5px;font-size:11px;color:var(--pulse-muted)}.seg button[aria-pressed=true]{background:var(--pulse-control);color:var(--pulse-foreground);box-shadow:0 1px 3px #0001}select{padding:4px 8px;font-size:11px;background:var(--pulse-background)}
    .scope-seg{position:relative;display:inline-grid;grid-template-columns:1fr 1fr;padding:3px;border:1px solid var(--pulse-border);background:var(--pulse-hover);border-radius:9px;gap:0;margin-bottom:6px;flex:none;isolation:isolate}#scope-controls[hidden]{display:none}.scope-thumb{position:absolute;top:3px;bottom:3px;left:3px;width:calc(50% - 3px);border-radius:6px;background:var(--pulse-card);border:1px solid color-mix(in srgb,var(--pulse-accent) 35%,var(--pulse-border));box-shadow:0 1px 3px var(--pulse-shadow);transition:transform 190ms cubic-bezier(.23,1,.32,1);pointer-events:none;z-index:0}.scope-seg[data-active-scope=account] .scope-thumb{transform:translateX(100%)}.scope-seg button{position:relative;z-index:1;background:transparent!important;box-shadow:none!important;padding:4px 12px;font-weight:500;transition:color 150ms ease}.scope-seg button[aria-pressed=true]{color:var(--pulse-foreground);font-weight:600}.page[data-scope-loading=true] .totals,.page[data-scope-loading=true] #overview,.page[data-scope-loading=true] #details{opacity:.62;transition:opacity 120ms ease}
    .heat-wrap{overflow-x:auto;padding:3px 3px 7px}.calendar{min-width:680px}.months{display:grid;margin-left:35px;font-size:11px;color:var(--pulse-muted);margin-bottom:7px}.months span{white-space:nowrap}.heat-row{display:flex;gap:9px}.weekdays{display:grid;grid-template-rows:repeat(7,1fr);width:26px;flex:none;font-size:11px;color:var(--pulse-muted)}.heat{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,1fr);gap:3px;width:100%}.heat button{border:0;border-radius:3px;padding:0;min-width:0;aspect-ratio:1;background:var(--pulse-hover);outline-offset:1px}.heat button[data-level="1"],.swatch[data-level="1"]{background:color-mix(in srgb,var(--pulse-accent) 22%,var(--pulse-hover))}.heat button[data-level="2"],.swatch[data-level="2"]{background:color-mix(in srgb,var(--pulse-accent) 45%,var(--pulse-hover))}.heat button[data-level="3"],.swatch[data-level="3"]{background:color-mix(in srgb,var(--pulse-accent) 68%,var(--pulse-hover))}.heat button[data-level="4"],.swatch[data-level="4"]{background:var(--pulse-accent)}.heat button.future{opacity:.25;cursor:default}.heat.week{grid-template-columns:repeat(26,minmax(0,1fr))!important;grid-template-rows:repeat(2,1fr);grid-auto-flow:row}.week button{max-height:28px;aspect-ratio:1}.heat-footer{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:8px 0 16px;font-size:11px;color:var(--pulse-muted)}.scale{display:flex;align-items:center;gap:4px}.swatch{width:11px;height:11px;border-radius:3px;background:var(--pulse-hover)}.selected{padding:12px 0 0;border-top:1px solid var(--pulse-separator);display:flex;justify-content:space-between;gap:16px;align-items:center}.selected button{border:0;color:var(--pulse-accent);font-size:12px;font-weight:550;padding:5px 8px}.selected button:hover{background:var(--pulse-hover)}.selected .title{font-weight:550;margin-bottom:2px}.selected strong{font-weight:550}
    .dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex:none;background:var(--pulse-foreground)}
    .chart-controls{display:flex;gap:10px;align-items:center}.range{display:flex;align-items:center;gap:10px}.range button{height:26px;width:26px;border:0}.range strong{font-size:12px;font-weight:500;min-width:106px;text-align:center}.legend{display:flex;flex-wrap:wrap;gap:3px 12px;margin:0 0 10px;max-height:46px;overflow-y:auto;padding-right:4px}.legend button{display:flex;align-items:center;gap:5px;padding:2px 0;border:0;border-radius:3px;background:transparent;font-size:11px;line-height:1.35;color:var(--pulse-muted)}.legend button:hover,.legend button[aria-pressed=true]{color:var(--pulse-foreground)}.legend button[aria-pressed=false]{opacity:.35;text-decoration:line-through}
    .chart-wrap{overflow-x:auto;border-bottom:1px solid var(--pulse-separator);padding:2px 0 8px;margin-bottom:10px}.chart-summary{font-size:11px;color:var(--pulse-muted);margin:0}.chart-summary strong{color:var(--pulse-foreground);font-weight:500}
    .table-wrap{overflow:visible}.table{width:100%;border-collapse:collapse;text-align:right;font-size:11px;white-space:nowrap}.table th{font-weight:500;color:var(--pulse-muted);padding:6px 8px;border-bottom:0;position:sticky;top:0;z-index:2;background:var(--pulse-background);box-shadow:inset 0 -1px 0 var(--pulse-separator)}.table td{padding:7px 8px;border-bottom:1px solid var(--pulse-separator)}.table td:nth-child(2),.table td.col-cost{font-weight:550}.table tbody tr:hover td{background:color-mix(in srgb,var(--pulse-hover) 55%,transparent)}.table th:first-child,.table td:first-child{text-align:left;padding-left:0}.table th:last-child,.table td:last-child{padding-right:0}.table td:first-child span{margin-right:7px}.table tr:last-child td{border-bottom:0}.cache-rate{display:inline-flex;align-items:center;justify-content:flex-end;gap:7px}.cache-bar{position:relative;display:inline-block;width:44px;height:3px;border-radius:2px;background:var(--pulse-separator);overflow:hidden;flex:none}.cache-bar i{display:block;height:100%;border-radius:2px;background:var(--pulse-foreground);opacity:.72}.cache-pct{display:inline-block;min-width:38px;text-align:right}.summary-cost{color:var(--pulse-foreground);font-weight:500}
    .footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:auto;padding-top:14px;font-size:11px;color:var(--pulse-muted)}.alert{color:var(--pulse-warning);margin-top:12px;font-size:11px}.tip{position:fixed;z-index:20;max-width:320px;padding:12px 14px;border:1px solid var(--pulse-border);border-radius:9px;background:var(--pulse-menu);box-shadow:0 8px 30px var(--pulse-shadow);color:var(--pulse-foreground);font-size:11px;pointer-events:none}.tip[hidden]{display:none}.tip .tip-title{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--pulse-muted);margin-bottom:5px}.tip strong{font-size:16px;font-weight:550}.tip-model{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:5px;padding:3px 0}.tip-model.dimmed{opacity:.5}.tip-model.active{font-weight:600}.tip-model .dot{margin-right:6px}.tier-cost{color:var(--pulse-foreground);font-weight:550;margin-left:7px}.model-share{font-size:11px;color:var(--pulse-muted);margin-left:8px}.tip-foot{font-size:10px;color:var(--pulse-muted);line-height:1.45;margin-top:4px}.usage-waiting{display:grid;place-items:center;min-height:260px;color:var(--pulse-muted);font-size:12px}.usage-waiting[hidden]{display:none}
    .year-picker{position:relative;flex:none}.year-trigger{display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:76px;height:30px;padding:0 10px;background:var(--pulse-control);color:var(--pulse-foreground);font-size:11px;border-radius:8px}.year-trigger:hover,.year-trigger[aria-expanded=true]{background:var(--pulse-hover)}.year-chevron{width:12px;height:12px;fill:none;stroke:var(--pulse-muted);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;transition:transform 160ms cubic-bezier(.23,1,.32,1)}.year-trigger[aria-expanded=true] .year-chevron{transform:rotate(180deg)}
    .year-menu{position:fixed;inset:auto;margin:0;padding:5px;width:112px;max-height:232px;overflow-y:auto;border:1px solid var(--pulse-border);border-radius:10px;background:var(--pulse-menu);color:var(--pulse-foreground);box-shadow:0 8px 26px var(--pulse-shadow);transform-origin:top right;opacity:1;transform:scale(1);transition:opacity 140ms ease,transform 160ms cubic-bezier(.23,1,.32,1)}.year-menu::backdrop{background:transparent;pointer-events:none}.year-option{width:100%;border:0;border-radius:6px;padding:7px 9px;display:flex;align-items:center;justify-content:space-between;gap:18px;font-size:12px;text-align:left;background:transparent;color:var(--pulse-foreground);font-variant-numeric:tabular-nums}.year-option:hover,.year-option:focus-visible{background:var(--pulse-hover)}.year-option[aria-selected=true]{background:color-mix(in srgb,var(--pulse-accent) 12%,var(--pulse-menu))}.year-check{color:var(--pulse-accent);width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;opacity:0}.year-option[aria-selected=true] .year-check{opacity:1}
    .usage-intro{margin:12px 0 0;padding:12px 14px;border:1px solid var(--pulse-separator);border-radius:10px;background:color-mix(in srgb,var(--pulse-hover) 45%,transparent)}.usage-intro[hidden]{display:none}
    .intro-heading{display:flex;align-items:center;gap:8px;margin-bottom:6px}.intro-heading h2{font-size:13px;font-weight:600;margin:0}.intro-mark{display:flex;color:var(--pulse-accent)}.intro-mark svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}
    .intro-copy{display:grid;gap:3px;color:var(--pulse-muted);font-size:12px;line-height:1.55}.intro-copy p{margin:0;font-size:12px}.intro-bottom{display:flex;justify-content:flex-end;align-items:center;gap:14px;margin-top:10px}.intro-bottom span{margin-right:auto;color:var(--pulse-warning);font-size:11px}
    #usage-intro-done{padding:5px 12px;min-height:28px;border:1px solid var(--pulse-border);border-radius:6px;background:var(--pulse-control);color:var(--pulse-foreground);font:inherit;font-size:11px;font-weight:550;cursor:pointer;transition:background-color 140ms ease,transform 120ms ease}#usage-intro-done:hover{background:var(--pulse-hover)}#usage-intro-done:active{transform:scale(.98)}#usage-intro-done:disabled{opacity:.55;cursor:wait}
    .mono-chart{min-width:600px}.mono-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:4px 0 2px;font-size:11px}.mono-head strong{font-size:12px;font-weight:600}.mono-head .muted{margin-left:4px}.mono-key{display:flex;align-items:center;gap:12px;color:var(--pulse-muted);font-size:11px}.mono-key>span{display:inline-flex;align-items:center;gap:5px}.mono-key svg{display:block;overflow:visible}.mono-sw{display:inline-block;width:9px;height:9px;border-radius:2px}.mono-sw.solid{background:var(--pulse-foreground)}.mono-sw.hatch{box-shadow:inset 0 0 0 1px var(--pulse-muted);background:repeating-linear-gradient(45deg,var(--pulse-muted) 0 1px,transparent 1px 3.5px)}.mono-svg+.mono-head{margin-top:12px;padding-top:10px;border-top:1px solid var(--pulse-separator)}
    .mono-svg{display:block;width:100%;height:auto;overflow:visible}.mono-svg text,.mono-key text{font-family:var(--pulse-font-mono,ui-monospace,'SFMono-Regular',Consolas,monospace);font-size:10px;fill:var(--pulse-muted)}.mono-svg .u-label{font-family:var(--pulse-font,inherit);font-size:11px}.mono-svg .u-label.strong{font-weight:600;fill:var(--pulse-foreground)}.mono-svg .u-label.small{font-size:10px}.mono-svg .u-label.row.on{fill:var(--pulse-foreground);font-weight:600}.mono-svg .u-side{font-family:var(--pulse-font,inherit);font-size:11px;font-weight:600;fill:var(--pulse-foreground)}.mono-svg .u-grid{stroke:var(--pulse-separator);stroke-width:1}.mono-svg .u-water{stroke:var(--pulse-foreground);stroke-width:1.2}.mono-svg .u-rest{fill:var(--pulse-background);stroke:var(--pulse-muted);stroke-width:1}.mono-svg .u-fresh{fill:var(--pulse-foreground)}.mono-svg .u-fresh.on{fill:var(--pulse-accent)}.mono-svg .u-cache-box{fill:var(--pulse-background);stroke:var(--pulse-muted);stroke-width:1}.mono-svg .u-cache-hatch{fill:none;stroke:var(--pulse-muted);stroke-width:1;pointer-events:none}.mono-svg .u-cache-box.on,.mono-svg .u-cache-hatch.on{stroke:var(--pulse-accent)}.mono-svg .u-dot{fill:var(--pulse-foreground);transition:opacity 140ms ease}.mono-svg .u-dot.on{fill:var(--pulse-accent)}.mono-svg .u-zero{fill:var(--pulse-muted);opacity:.4}.mono-chart.row-focus .u-dot:not(.on){opacity:.16}.mono-svg .u-band{fill:var(--pulse-hover);visibility:hidden}.mono-svg .u-band.show{visibility:visible}.mono-svg .u-x{opacity:0}.mono-svg .u-x.tick{opacity:1}.mono-svg .u-x.on{opacity:1;fill:var(--pulse-accent);font-weight:700}.mono-svg .u-hit{fill:transparent}.mono-svg .u-hit:focus{outline:none}.mono-svg .u-hit:focus-visible{stroke:var(--pulse-accent);stroke-width:1}.mono-empty{padding:64px 0;text-align:center;color:var(--pulse-muted);font-size:12px}.tip-sub{font-size:10px;color:var(--pulse-muted);padding-left:10px}.tip-rule{height:1px;background:var(--pulse-separator);margin:6px 0 2px}
    @media(prefers-reduced-motion:reduce){.mono-svg .u-dot{transition:none}}
    @starting-style{.year-menu:popover-open{opacity:0;transform:scale(.97)}}
    @media(max-width:860px){.totals{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:12px}.metric:nth-child(3n+1){padding-left:0;border-left:0}.metric:nth-child(3n){padding-right:0}}
    @media(max-width:760px){.table-wrap{overflow-x:auto}}
    @media(max-width:650px){.page-head{padding:14px 16px 0}.page-body{margin-right:2px;padding:0 8px 14px 16px}.tabs-bar{flex-wrap:wrap;gap:8px}.totals{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 0}.metric{padding:0 12px}.metric:nth-child(odd){padding-left:0;border-left:0}.metric:nth-child(even){padding-left:12px;padding-right:0;border-left:1px solid var(--pulse-separator)}.value{font-size:17px}.section-head{align-items:flex-start;flex-wrap:wrap}.chart-controls{width:100%;justify-content:space-between}.table-wrap{overflow-x:auto}.footer{align-items:flex-start;flex-direction:column;gap:5px}.selected{align-items:flex-start}}
    @media(max-width:520px){.intro-bottom{align-items:flex-start}.intro-bottom span{line-height:1.5}}
    @media(prefers-reduced-motion:reduce){button,.year-menu,.year-chevron,.scope-thumb,.totals,#overview,#details{transition:none}button:active{transform:none}}
  `;view.append(css);
  const page=document.createElement('div');page.className='page';
  setMarkup(page,`<div class="page-head"><header class="top"><div><h1 id="title"></h1><div class="sub"><span class="live-dot"></span><span id="subtitle"></span></div></div><div class="actions"><button id="locale" type="button" aria-label="Language"><span id="locale-label" class="locale-label">中</span></button><button id="refresh" type="button" aria-label="Refresh"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 7a5 5 0 1 0-1.3 4.4M13 3v4H9"/></svg></button><button id="close" type="button" aria-label="Close"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></div></header><div class="tabs-bar"><nav class="tabs" role="tablist"><button id="overview-tab" role="tab" aria-controls="overview"></button><button id="details-tab" role="tab" aria-controls="details"></button></nav><div class="seg scope-seg" id="scope-controls" role="group" hidden><i class="scope-thumb" aria-hidden="true"></i><button type="button" data-usage-scope="local"></button><button type="button" data-usage-scope="account"></button></div></div></div><div class="page-body" id="page-body"><div class="totals" id="totals"></div><section id="usage-waiting" class="usage-waiting" role="status" hidden></section><section id="overview" role="tabpanel"><div class="section-head"><div><h2 id="activity-title"></h2><div class="muted" id="heat-sub"></div></div><div class="chart-controls"><div class="seg" id="heat-controls"><button data-heat="day"></button><button data-heat="week"></button></div><div class="year-picker"><button id="year" type="button" class="year-trigger" aria-label="Year" aria-haspopup="listbox" aria-controls="year-menu" aria-expanded="false"><span id="year-label"></span><svg class="year-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><div id="year-menu" class="year-menu" role="listbox" aria-label="Year" popover="manual"></div></div></div></div><div class="heat-wrap"><div class="calendar"><div class="months" id="months"></div><div class="heat-row"><div class="weekdays" id="weekdays"></div><div class="heat" id="heat"></div></div></div></div><div class="heat-footer"><span id="heat-summary"></span><div class="scale"><span id="less"></span><i class="swatch"></i><i class="swatch" data-level="1"></i><i class="swatch" data-level="2"></i><i class="swatch" data-level="3"></i><i class="swatch" data-level="4"></i><span id="more"></span></div></div><div class="selected"><div><div class="title" id="selection-title"></div><span class="muted" id="selection-value"></span></div><button id="selection-details"></button></div></section><section id="details" role="tabpanel" hidden><div class="section-head"><h2 id="detail-title"></h2><div class="chart-controls"><div class="range"><button id="previous" aria-label="Previous">‹</button><strong id="range-label"></strong><button id="next" aria-label="Next">›</button></div><div class="seg" id="period-controls"><button data-period="day"></button><button data-period="week"></button><button data-period="month"></button></div></div></div><div class="legend" id="legend"></div><div class="chart-wrap"><div class="mono-chart" id="mono-chart"></div></div><div class="table-wrap"><table class="table"><thead><tr id="table-head"></tr></thead><tbody id="table-body"></tbody></table></div></section><div class="alert" id="alert" hidden></div><footer class="footer"><span id="coverage"></span><span id="timezone"></span></footer></div><div class="tip" id="tip" role="status" hidden></div>`);view.append(page);
  const intro=document.createElement('section');intro.id='usage-intro';intro.className='usage-intro';intro.hidden=true;intro.setAttribute('aria-labelledby','usage-intro-title');
  setMarkup(intro,'<div class="intro-heading"><span class="intro-mark" aria-hidden="true"><svg viewBox="0 0 16 16"><ellipse cx="8" cy="4" rx="5" ry="2"/><path d="M3 4v8c0 2 10 2 10 0V4M3 8c0 2 10 2 10 0"/></svg></span><h2 id="usage-intro-title"></h2></div><div class="intro-copy"><p id="usage-intro-history"></p><p id="usage-intro-scope"></p><p id="usage-intro-storage"></p></div><div class="intro-bottom"><span id="usage-intro-error" role="status"></span><button id="usage-intro-done" type="button"></button></div>');
  page.querySelector('#totals').before(intro);
  const $=id=>view.getElementById(id),text=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
  let value=null,tab='overview',heatMode='day',period='day',year=null,anchor=null,selected=null,disabledModels=new Set(),lastKey='',busy=false,opener=null;
  let disposed=false,refreshMotion=null,refreshDelay=null,finishRefresh=null,accountKey=null,tipTarget=null,tipModel=null,lastScrollTop=0,activeHover=null,restoringDom=false,suppressScrollTipHide=false;
  const scopeCache=new Map();let pendingScope=null,scopeLoading=false,scopeAnimations=[];
  function animateScopeChange(){
    for(const anim of scopeAnimations)anim.cancel();scopeAnimations=[];
    if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    for(const el of [$('subtitle'),$('totals'),$(tab==='overview'?'overview':'details'),$('usage-waiting')]){
      if(!el||el.hidden)continue;
      scopeAnimations.push(el.animate([{opacity:.45,transform:'translateY(3px)'},{opacity:1,transform:'translateY(0)'}],{duration:180,easing:'cubic-bezier(0.23,1,0.32,1)'}));
    }
  }
  const zh=()=>language.language==='zh-CN'||language.language==='zh-TW',tw=()=>language.language==='zh-TW',w=(cn,en,twText)=>(tw()&&twText!==undefined)?twText:(zh()?cn:en);
  let guideSaving=false,guideError=false,guideSignature=null;
  const replayGuide=window.__agPulseUsageGuidePreview===true;
  function renderGuide(){
    const signature=language.language+'|'+themeSignature();
    if(replayGuide&&signature!==guideSignature){guideDismissed=false;guideError=false;}
    guideSignature=signature;intro.hidden=guideDismissed;
    text('usage-intro-title',w('先了解你的用量统计','About your token usage','先了解您的用量統計'));
    text('usage-intro-history',w('自动汇总本机 Antigravity 可读取的本地历史对话，再持续记录新请求（默认统计本机全部流经流量，也可切换查看当前账号）；已删除或缺失的历史可能无法补齐。','Available local conversations are imported automatically and new requests are recorded continuously (defaulting to all local Antigravity traffic, with an option to filter by the current account). Deleted or missing history may leave gaps.','自動彙總本機 Antigravity 可讀取的本機歷史對話，並持續記錄新請求（預設統計本機全部流經流量，亦可切換檢視目前帳號）；已刪除或缺失的記錄可能無法補齊。'));
    text('usage-intro-scope',w('统计仅代表本机已记录的 Token 用量，不是账户账单；天、周、月均按 UTC+8 划分。','Totals cover usage recorded on this device, not account billing. Days, weeks and months use UTC+8.','統計僅代表本機已記錄的 Token 用量，非帳號帳單；日、週、月均按 UTC+8 劃分。'));
    text('usage-intro-storage',w('只在本地保存时间、模型和用量，不保存对话正文。删除对话不会扣除已记录的用量。','Only times, models and usage counters are saved locally, never conversation text. Deleting a chat does not subtract usage already recorded.','僅於本機儲存時間、模型與用量，不儲存對話內文。刪除對話不會扣減已記錄的用量。'));
    text('usage-intro-done',guideSaving?w('保存中…','Saving…','儲存中…'):w('知道了','Got it','我知道了'));
    text('usage-intro-error',guideError?w('未能保存，请再试一次。','Could not save. Please try again.','未能儲存，請再試一次。'):'' );
    $('usage-intro-done').disabled=guideSaving;$('usage-intro-done').setAttribute('aria-busy',String(guideSaving));
  }
  function dismissGuide(){
    if(disposed)return;const focused=view.activeElement===$('usage-intro-done');guideDismissed=true;renderGuide();
    if(focused&&dialog.open)$('overview-tab').focus({preventScroll:true});
  }
  $('usage-intro-done').addEventListener('click',async()=>{
    if(guideSaving||disposed)return;guideSaving=true;guideError=false;renderGuide();
    try{await onDismissGuide();dismissGuide();}catch{if(!disposed)guideError=true;}
    finally{guideSaving=false;if(!disposed)renderGuide();}
  });
  const full=n=>Number(n||0).toLocaleString(language.language==='en'?'en-US':language.language);
  const compact=n=>{n=Number(n||0);for(const [base,suffix,nextBase,nextSuffix]of [[1e12,'T',0,''],[1e9,'B',1e12,'T'],[1e6,'M',1e9,'B'],[1e3,'K',1e6,'M']])if(n>=base){const scaled=n/base,rounded=Number(scaled.toFixed(1));return nextBase&&rounded*base>=nextBase?`1${nextSuffix}`:`${rounded}${suffix}`;}return full(n);};
  const add=(date,days)=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10);};
  const week=date=>{const d=new Date(date+'T00:00:00Z');return add(date,-((d.getUTCDay()+6)%7));};
  const month=(date,shift)=>{const d=new Date(date.slice(0,7)+'-01T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+shift);return d.toISOString().slice(0,10);};
  let modelAliases=pricing.buildShortAliases([]);
  const parseModelTier=raw=>pricing.parseModelTier(raw,modelAliases);
  const modelPrice=pricing.modelPrice;
  const tokenCost=pricing.tokenCost;
  const quotaFamily=pricing.quotaFamily;
  const usd=v=>{if(v===null||v===undefined||!Number.isFinite(v))return '—';if(v===0)return '$0.00';if(v<0.01)return '$'+v.toFixed(3);return '$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});};
  // Table cells keep a bounded width as usage grows: below 1,000 the exact value is shown; from 1,000 upward the value
  // keeps 3 significant digits and steps through K/M/B/T (1.84M, 41.4M, 736M), so every cell stays within 5 characters
  // (cost within 7, e.g. $291.37 / $1.23K). Exact values remain available in each cell's title.
  const scaleUnits=['K','M','B','T'];
  const sig3=n=>{let i=Math.min(scaleUnits.length-1,Math.max(0,Math.floor(Math.log10(n)/3)-1));for(;;){const text=(n/10**(3*(i+1))).toPrecision(3);if(Number(text)>=1000&&i<scaleUnits.length-1){i++;continue;}if(Number(text)<1&&i>0){i--;continue;}return (text.includes('e')?Number(text).toFixed(0):text)+scaleUnits[i];}};
  const shortNum=n=>{n=Number(n||0);if(!Number.isFinite(n))return '—';const sign=n<0?'-':'';n=Math.abs(n);return sign+(Math.round(n)<1e3?full(Math.round(n)):sig3(n));};
  const shortUsd=v=>{if(v===null||v===undefined||!Number.isFinite(v))return '—';return Math.round(Math.abs(v)*100)<1e5?usd(v):(v<0?'-$':'$')+sig3(Math.abs(v));};
  const compactUsd=v=>{if(v===null||v===undefined||!Number.isFinite(v))return '—';if(v===0)return '$0.00';if(v<0.01)return '$'+v.toFixed(3);if(v<1000)return '$'+v.toFixed(2);if(v<10000)return '$'+Math.round(v).toLocaleString('en-US');return '$'+(v/1000).toFixed(1)+'K';};
  const familyLabel=f=>f==='gemini-argon'?'Argon':f==='3p'?'Claude / GPT':'Gemini';
  function computeOverviewFinance(){
    const today=value?.today||'',weekFrom=today?week(today):'',monthFrom=today?month(today,0):'',recentFrom=today?add(today,-6):'';
    const qw=value?.quotaWindows&&typeof value.quotaWindows==='object'?value.quotaWindows:{};
    const weeklyEntries=Object.entries(qw).filter(([k])=>k.endsWith(':weekly'));
    const hasDedicatedArgon=weeklyEntries.some(([k])=>quotaFamily(k.slice(0,-7))==='gemini-argon');
    const normFam=raw=>{const f=quotaFamily(raw);return f==='gemini-argon'&&!hasDedicatedArgon?'gemini':f;};
    let allCost=0,allPriced=false,allUnpriced=false,todayCost=0,todayPriced=false,weekCost=0,weekPriced=false,monthCost=0,monthPriced=false;
    const recentPool={},allPool={};let recentAllCost=0,recentAllTok=0,totalAllTok=0;
    for(const day of value?.days||[]){
      const inToday=day.date===today,inWeek=weekFrom&&day.date>=weekFrom&&day.date<=today,inMonth=monthFrom&&day.date>=monthFrom&&day.date<=today,inRecent=recentFrom&&day.date>=recentFrom&&day.date<=today;
      for(const [rawModel,r]of Object.entries(day.models||{})){
        const {key:model}=parseModelTier(rawModel),p=modelPrice(model,day.date),c=tokenCost(r,p),tok=r.total||0;
        if(c===null){if(tok>0)allUnpriced=true;continue;}
        allCost+=c;allPriced=true;totalAllTok+=tok;
        if(inToday){todayCost+=c;todayPriced=true;}
        if(inWeek){weekCost+=c;weekPriced=true;}
        if(inMonth){monthCost+=c;monthPriced=true;}
        if(inRecent){recentAllCost+=c;recentAllTok+=tok;}
        const fam=normFam(model);
        if(fam&&tok>0){
          const ap=allPool[fam]||(allPool[fam]={cost:0,tok:0});ap.cost+=c;ap.tok+=tok;
          if(inRecent){const rp=recentPool[fam]||(recentPool[fam]={cost:0,tok:0});rp.cost+=c;rp.tok+=tok;}
        }
      }
    }
    const fallbackRate=recentAllTok>0?recentAllCost/recentAllTok:(totalAllTok>0?allCost/totalAllTok:null);
    const rateFor=fam=>{
      const rp=fam&&recentPool[fam];if(rp&&rp.tok>0)return rp.cost/rp.tok;
      const ap=fam&&allPool[fam];if(ap&&ap.tok>0)return ap.cost/ap.tok;
      return fallbackRate;
    };
    const pools=[];let weeklyTotal=0,waitingSamples=false;
    for(const [k,win]of weeklyEntries){
      const gid=k.slice(0,-7),fam=normFam(gid);
      const fullUsdDirect=Number.isFinite(win?.estimatedFullUsd)&&win.estimatedFullUsd>0?win.estimatedFullUsd:null;
      const fullTokDirect=Number.isFinite(win?.estimatedFullTokens)&&win.estimatedFullTokens>0?win.estimatedFullTokens:null;
      if(!fullUsdDirect&&!fullTokDirect){if(win?.observedTokens>0||win?.usedFraction>0)waitingSamples=true;continue;}
      const rate=rateFor(fam);
      const estUsd=fullUsdDirect??(rate!==null&&fullTokDirect?fullTokDirect*rate:null);
      if(estUsd===null)continue;
      const fullTok=fullUsdDirect!==null&&rate>0?Math.round(fullUsdDirect/rate):fullTokDirect;
      weeklyTotal+=estUsd;
      pools.push({label:familyLabel(fam),usd:estUsd,fullTokens:fullTok,usedFraction:typeof win.usedFraction==='number'?win.usedFraction:null,costBased:fullUsdDirect!==null});
    }
    const zeroAll=!allPriced&&Number(value?.totalTokens||0)===0;
    return {
      allCost:allPriced?allCost:(zeroAll?0:null),allUnpriced,
      todayCost:todayPriced?todayCost:null,weekCost:weekPriced?weekCost:null,monthCost:monthPriced?monthCost:null,
      weeklyEst:pools.length?{totalUsd:weeklyTotal,pools}:null,waitingSamples,
    };
  }
  function priceHint(p){
    if(!p)return w('暂无官网公开标价','No official list price available','暫無官網公開標價');
    const b=p.base,core=w(`输入 $${b[0]}/M · 缓存 $${b[1]}/M · 输出 $${b[3]}/M`,`In $${b[0]}/M · Cache $${b[1]}/M · Out $${b[3]}/M`,`輸入 $${b[0]}/M · 快取 $${b[1]}/M · 輸出 $${b[3]}/M`);
    if(p.longAt&&p.long){
      const k=Math.round(p.longAt/1000)+'K',l=p.long;
      return w(`官网 API 标价（≤${k}）：${core}；>${k} 档：$${l[0]}/$${l[1]}/$${l[3]}/M（思考计入输出）`,`Official API (≤${k}): ${core}; >${k}: $${l[0]}/$${l[1]}/$${l[3]}/M (thinking billed as output)`,`官網 API 標價（≤${k}）：${core}；>${k} 檔：$${l[0]}/$${l[1]}/$${l[3]}/M（思考計入輸出）`);
    }
    const tag=p.note==='flat1m'?w('1M 统一价，同档单价·思考计入输出','Flat 1M rate · thinking billed as output','1M 統一價，同檔單價·思考計入輸出'):p.note==='intro'?w('当前优惠价，同档单价·思考计入输出','Active intro rate · thinking billed as output','目前優惠價，同檔單價·思考計入輸出'):w('同档单价·思考计入输出','Uniform effort rate · thinking billed as output','同檔單價·思考計入輸出');
    return w(`官网 API 标价（${tag}）：${core}`,`Official API (${tag}): ${core}`,`官網 API 標價（${tag}）：${core}`);
  }
  let modelDisplay=new Map(),modelFull=new Map(),mergedModelList=[];
  function syncModels(){
    modelDisplay.clear();modelFull.clear();
    const allRaw=[];
    for(const raw of value?.models||[])allRaw.push(raw);
    for(const day of value?.days||[])for(const raw of Object.keys(day.models||{}))allRaw.push(raw);
    modelAliases=pricing.buildShortAliases(allRaw);
    const seen=new Map();
    for(const raw of allRaw){
      const p=parseModelTier(raw);
      const prev=seen.get(p.key);
      if(!prev||(!prev.hasDisplay&&p.hasDisplay))seen.set(p.key,p);
      if(!modelDisplay.has(p.key)||(!prev?.hasDisplay&&p.hasDisplay)){modelDisplay.set(p.key,p.name);modelFull.set(p.key,p.fullName);}
    }
    mergedModelList=[...seen.keys()];
  }
  const modelName=key=>modelDisplay.get(key)||parseModelTier(key).name;
  const fullModelName=key=>modelFull.get(key)||parseModelTier(key).fullName;
  const themeSignature=()=>{const s=getComputedStyle(root.host||dialog);return [s.getPropertyValue('--pulse-accent'),s.getPropertyValue('--pulse-background'),s.getPropertyValue('--pulse-font'),root.host?.dataset.pulseTheme].join('|');};
  const totals=(from,to,filter=false)=>{
    const models={};let cost=0,priced=false,unpriced=false;
    for(const day of value?.days||[])if(day.date>=from&&day.date<=to)for(const [rawModel,r]of Object.entries(day.models)){
      const {key:model,tier}=parseModelTier(rawModel);
      if(filter&&disabledModels.has(model))continue;
      const entry=models[model]||(models[model]={total:0,requests:0,uncached:0,cacheRead:0,cacheWrite:0,output:0,cost:0,priced:false,tiers:{}});
      for(const field of ['total','requests','uncached','cacheRead','cacheWrite','output'])entry[field]+=r[field]||0;
      const p=modelPrice(model,day.date),c=tokenCost(r,p);
      if(c!==null){entry.cost+=c;entry.priced=true;cost+=c;priced=true;}else if(r.total>0)unpriced=true;
      const tierEntry=entry.tiers[tier]||(entry.tiers[tier]={total:0,requests:0,output:0,cost:0,priced:false});
      tierEntry.total+=r.total||0;tierEntry.requests+=r.requests||0;tierEntry.output+=r.output||0;
      if(c!==null){tierEntry.cost+=c;tierEntry.priced=true;}
    }
    return {from,to,models,total:Object.values(models).reduce((n,r)=>n+r.total,0),requests:Object.values(models).reduce((n,r)=>n+r.requests,0),cost:priced?cost:null,unpriced};
  };
  const node=(tag,className,content)=>{const n=document.createElement(tag);if(className)n.className=className;if(content!==undefined)n.textContent=content;return n;};
  function hideTip(){$('tip').hidden=true;tipTarget=null;tipModel=null;}
  function positionTip(rect,clientX=null){
    const tip=$('tip');tip.hidden=false;
    const bounds=dialog.getBoundingClientRect(),r=tip.getBoundingClientRect();
    const anchorX=typeof clientX==='number'&&Number.isFinite(clientX)?clientX:rect.left+rect.width/2;
    tip.style.left=Math.min(bounds.right-r.width-12,Math.max(bounds.left+12,anchorX-r.width/2))+'px';
    const above=rect.top-r.height-10;
    tip.style.top=(above>=bounds.top+12?above:Math.min(bounds.bottom-r.height-12,rect.bottom+8))+'px';
  }
  function tooltip(bucket,target,activeModel=null){
    if(!$('tip').hidden&&tipTarget===target&&tipModel===activeModel)return;tipTarget=target;tipModel=activeModel;
    highlightModel(activeModel);
    const tip=$('tip');tip.replaceChildren(node('div','tip-title',bucket.from===bucket.to?bucket.from:bucket.from+' – '+bucket.to),node('strong','',full(bucket.total)+' Token'),node('div','muted',w(`${bucket.requests} 次请求`,`${bucket.requests} requests`,`${bucket.requests} 次請求`)));
    for(const [model,r]of Object.entries(bucket.models).sort((a,b)=>b[1].total-a[1].total)){
      const row=node('div','tip-model'+(activeModel?(activeModel===model?' active':' dimmed'):'')),label=node('span',''),dot=node('i','dot'),amount=node('span','',compact(r.total));label.append(dot,document.createTextNode(modelName(model)));amount.append(node('span','model-share',bucket.total?(r.total/bucket.total*100).toFixed(1)+'%':'0%'));row.append(label,amount);tip.append(row);
    }
    positionTip(target.getBoundingClientRect());
  }
  function tierTooltip(model,r,row,clientX=null,refDate=''){
    const tiers=Object.entries(r.tiers||{}).filter(([,v])=>v.total>0||v.requests>0).sort((a,b)=>b[1].total-a[1].total);
    if(tiers.length<2)return;
    if(!$('tip').hidden&&tipTarget===row&&tipModel===model)return;
    tipTarget=row;tipModel=model;
    const tip=$('tip'),title=node('div','tip-title'),dot=node('i','dot');
    const hasOrch=tiers.some(([tier])=>tier.includes('Orchestrator'));
    title.append(dot,document.createTextNode(fullModelName(model)+' · '+(hasOrch?w('模式与档位','Modes & tiers','模式與檔位'):w('档位分布','Thinking tiers','檔位分佈'))));
    tip.replaceChildren(title);
    for(const [tier,stats]of tiers){
      const item=node('div','tip-model'),label=node('span','',tier||w('默认','Default','預設')),amount=node('span','',compact(stats.total));
      if(stats.priced)amount.append(node('span','tier-cost',usd(stats.cost)));
      amount.append(node('span','model-share',r.total?(stats.total/r.total*100).toFixed(1)+'%':'0%'));
      item.append(label,amount);tip.append(item);
    }
    const p=modelPrice(model,refDate||value?.today||'');
    if(p){tip.append(node('div','tip-rule'),node('div','tip-foot',priceHint(p)));}
    positionTip(row.getBoundingClientRect(),clientX);
  }
  const bindBucket=(button,bucket)=>{
    button.dataset.from=bucket.from;button.dataset.to=bucket.to;
    button.setAttribute('aria-label',(bucket.from===bucket.to?bucket.from:bucket.from+' – '+bucket.to)+': '+full(bucket.total)+' Token');
    button.addEventListener('pointerenter',()=>{activeHover={source:'heat',from:bucket.from,to:bucket.to,viaFocus:false};tooltip(bucket,button);});
    button.addEventListener('pointerleave',()=>{if(restoringDom)return;if(activeHover?.source==='heat'&&activeHover.from===bucket.from&&activeHover.to===bucket.to&&!activeHover.viaFocus){activeHover=null;hideTip();highlightModel(null);}});
    button.addEventListener('focus',()=>{activeHover={source:'heat',from:bucket.from,to:bucket.to,viaFocus:true};tooltip(bucket,button);});
    button.addEventListener('blur',()=>{if(restoringDom)return;if(activeHover?.source==='heat'&&activeHover.from===bucket.from&&activeHover.to===bucket.to){activeHover=null;hideTip();highlightModel(null);}});
    button.addEventListener('click',()=>{selected=bucket;anchor=bucket.from;showSelection();});
  };
  function showSelection(){const bucket=selected||totals(value.today,value.today);text('selection-title',bucket.from===bucket.to?bucket.from:bucket.from+' – '+bucket.to);text('selection-value',full(bucket.total)+' Token · '+w(`${bucket.requests} 次请求`,`${bucket.requests} requests`,`${bucket.requests} 次請求`));}
  function renderHeat({preserveHover=false}={}){
    if(!value)return;
    const savedHover=preserveHover&&activeHover?.source==='heat'?{...activeHover}:null;
    const start=week(year+'-01-01'),end=year+'-12-31',weeks=Math.floor((Date.parse(end)-Date.parse(start))/604800000)+1;
    $('heat').className='heat'+(heatMode==='week'?' week':'');
    $('heat').style.gridTemplateColumns=`repeat(${weeks},minmax(0,1fr))`;
    if(heatMode==='week')$('heat').style.setProperty('grid-template-columns',`repeat(${Math.ceil(weeks/2)},minmax(0,1fr))`,'important');
    const buckets=[];for(let i=0;i<(heatMode==='day'?weeks*7:weeks);i++){
      const date=add(start,heatMode==='day'?i:i*7),to=heatMode==='day'?date:add(date,6);
      buckets.push(heatMode==='day'?totals(date,date):totals(date<year+'-01-01'?year+'-01-01':date,to>end?end:to));
    }
    const max=Math.max(1,...buckets.map(b=>b.total));
    const heatNodes=[];let restoredTarget=null;
    for(const bucket of buckets){
      const button=node('button','');button.type='button';const future=bucket.from>value.today||bucket.to<year+'-01-01'||bucket.from>year+'-12-31';
      button.dataset.level=bucket.total===0?'0':String(Math.min(4,Math.ceil(bucket.total/max*4)));if(future){button.className='future';button.disabled=true;}
      if(!future){bindBucket(button,bucket);if(savedHover&&bucket.from===savedHover.from&&bucket.to===savedHover.to)restoredTarget={bucket,button};}
      button.tabIndex=-1;heatNodes.push(button);
    }
    const usable=heatNodes.filter(b=>!b.disabled),lastActive=[...heatNodes].reverse().find(b=>!b.disabled&&b.dataset.level!=='0');
    if(usable.length)(lastActive||usable.at(-1)).tabIndex=0;
    const monthNodes=[],weekdayNodes=[];
    if(heatMode==='day'){
      $('months').style.gridTemplateColumns=`repeat(${weeks},minmax(0,1fr))`;
      for(let m=1;m<=12;m++){const date=`${year}-${String(m).padStart(2,'0')}-01`,col=Math.floor((Date.parse(date)-Date.parse(start))/604800000)+1;
        const label=node('span','',zh()?m+'月':['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]);label.style.gridColumn=col;label.style.gridRow=1;monthNodes.push(label);}
      for(let i=0;i<7;i++)weekdayNodes.push(node('span','',i%2===0?(zh()?['一','','三','','五','','日'][i]:['M','','W','','F','','S'][i]):''));
    }
    restoringDom=true;
    try{$('heat').replaceChildren(...heatNodes);$('months').replaceChildren(...monthNodes);$('weekdays').replaceChildren(...weekdayNodes);}finally{restoringDom=false;}
    text('heat-sub',heatMode==='day'?w('每格代表一天','Each square is one day','每格代表一天'):w('每格代表一周 · 周一开始','Each square is one week · starts Monday','每格代表一週 · 週一開始'));
    const annual=totals(year+'-01-01',year+'-12-31');text('heat-summary',w(`${year} 年 · ${full(annual.total)} Token`,`${year} · ${full(annual.total)} tokens`,`${year} 年 · ${full(annual.total)} Token`));
    for(const b of view.querySelectorAll('[data-heat]'))b.setAttribute('aria-pressed',String(b.dataset.heat===heatMode));showSelection();
    if(restoredTarget){
      activeHover=savedHover;tooltip(restoredTarget.bucket,restoredTarget.button);
      if(savedHover.viaFocus){restoringDom=true;try{restoredTarget.button.focus({preventScroll:true});}finally{restoringDom=false;}}
    }else if(savedHover||activeHover?.source==='heat'){activeHover=null;hideTip();}
  }
  function highlightModel(model){monoFocusModel(model);}
  const chartSummary=node('div','chart-summary');$('detail-title').after(chartSummary);
  const chartHeading=node('div','detail-heading');$('detail-title').before(chartHeading);chartHeading.append($('detail-title'),chartSummary);
  // --- Monochrome instrument -------------------------------------------------
  // One ink from the host theme; the host accent marks only the hovered bucket,
  // model or cell. Above the waterline: new tokens (uncached input + cache
  // writes + output). Below: cache reads, on the same scale.
  const SVG_NS='http://www.w3.org/2000/svg';
  const monoWrap=$('mono-chart'),chartWrap=monoWrap.parentElement;
  let monoBuckets=[],monoGeo=null,monoKey='',monoWidth=0;
  const svgEl=(tag,attrs,parent,content)=>{const n=document.createElementNS(SVG_NS,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(content!==undefined)n.textContent=content;if(parent)parent.append(n);return n;};
  const niceStep=v=>{if(!(v>0))return 0;const p=10**Math.floor(Math.log10(v)),m=v/p;return (m>=5?5:m>=2?2:1)*p;};
  const roundEnd=(x,y,wd,h,r,top)=>{r=Math.min(r,h,wd/2);return top?`M${x},${y+h}V${y+r}Q${x},${y} ${x+r},${y}H${x+wd-r}Q${x+wd},${y} ${x+wd},${y+r}V${y+h}Z`:`M${x},${y}V${y+h-r}Q${x},${y+h} ${x+r},${y+h}H${x+wd-r}Q${x+wd},${y+h} ${x+wd},${y+h-r}V${y}Z`;};
  // Explicit 45° strokes instead of an SVG pattern: url(#id) fills are not
  // reliably resolved inside this shadow root across host versions.
  const hatchPath=(x0,y0,x1,y1,step=3.6)=>{let d='';for(let c=x0+y0+step/2;c<x1+y1;c+=step){const ax=Math.max(x0,c-y1),bx=Math.min(x1,c-y0);if(bx-ax>.2)d+=`M${ax.toFixed(1)},${(c-ax).toFixed(1)}L${bx.toFixed(1)},${(c-bx).toFixed(1)}`;}return d;};
  const shortName=name=>name.length>24?name.slice(0,23)+'…':name;
  const monoLabel=(bucket,i)=>period==='day'?String(i+1):period==='week'?bucket.from.slice(5):bucket.from.slice(0,7);
  const monoTick=(i,n)=>period!=='day'||i%3===0||i===n-1;
  const monoPct=(v,total)=>total?(v/total*100).toFixed(1)+'%':'—';
  function monoSplit(bucket){let cache=0,uncached=0,write=0,output=0;for(const r of Object.values(bucket.models)){cache+=r.cacheRead||0;uncached+=r.uncached||0;write+=r.cacheWrite||0;output+=r.output||0;}return {cache,uncached,write,output,fresh:Math.max(0,bucket.total-cache)};}
  const bucketLabel=bucket=>bucket.from===bucket.to?bucket.from:bucket.from+' – '+bucket.to;
  function restoreScroll(body,savedTop){
    if(body.scrollTop!==savedTop){suppressScrollTipHide=true;body.scrollTop=savedTop;requestAnimationFrame(()=>{suppressScrollTipHide=false;});}
  }
  function renderMono(buckets,{preserveHover=false}={}){
    const savedHover=preserveHover&&activeHover?.source==='mono'?{...activeHover}:null;
    const body=$('page-body'),savedTop=body.scrollTop,savedLeft=chartWrap.scrollLeft;
    const width=Math.max(600,Math.floor(chartWrap.clientWidth||720));
    monoBuckets=buckets;monoKey='';monoWidth=width;monoWrap.classList.remove('row-focus');
    if(!buckets.some(b=>b.total)){
      restoringDom=true;
      try{monoWrap.replaceChildren(node('div','mono-empty',w('所选时段暂无用量记录','No usage recorded in this period','所選時段尚無用量記錄')));}finally{restoringDom=false;}
      if(savedHover){activeHover=null;hideTip();}
      restoreScroll(body,savedTop);return;
    }
    const n=buckets.length,L=150,R=78,plotW=width-L-R,cell=plotW/n,bw=Math.max(3,Math.min(cell*.58,22)),cx=i=>L+(i+.5)*cell,G=1.5,today=value?.today||'9999-12-31';
    monoGeo={L,cell};
    const splits=buckets.map(monoSplit),maxFresh=Math.max(0,...splits.map(s=>s.fresh)),maxCache=Math.max(0,...splits.map(s=>s.cache));
    const sum=splits.reduce((a,s)=>{a.fresh+=s.fresh;a.cache+=s.cache;return a;},{fresh:0,cache:0}),grand=sum.fresh+sum.cache;
    const per=period==='day'?w('每日','Daily','每日'):period==='week'?w('每周','Weekly','每週'):w('每月','Monthly','每月');
    const headA=node('div','mono-head'),leftA=node('div','');leftA.append(node('strong','',w(`${per} Token · 冰山`,`${per} tokens · iceberg`,`${per} Token · 冰山`)),node('span','muted',w('水线以上为新增，以下为缓存读取，上下同一比例尺','Above the line: new · below: cache reads · same scale','水線以上為新增，以下為快取讀取，上下同一比例尺')));
    const keyA=node('div','mono-key'),k1=node('span',''),k2=node('span','');k1.append(node('i','mono-sw solid'),document.createTextNode(w('新增','New','新增')));k2.append(node('i','mono-sw hatch'),document.createTextNode(w('缓存读取','Cache read','快取讀取')));keyA.append(k1,k2);headA.append(leftA,keyA);
    const plotH=Math.max(150,Math.min(230,width*.22)),k=plotH/((maxFresh+maxCache)||1),top=22,wl=top+maxFresh*k+G,bottom=wl+G+maxCache*k,H=Math.ceil(bottom+26),tH=wl-top,bH=bottom-wl;
    const svgA=svgEl('svg',{class:'mono-svg iceberg',viewBox:`0 0 ${width} ${H}`,width,height:H,role:'img','aria-label':w('Token 冰山图','Token iceberg chart','Token 冰山圖')});
    svgEl('rect',{class:'u-band',x:0,y:0,width:cell,height:bottom+4},svgA);
    const grid=(v,y)=>{svgEl('line',{class:'u-grid',x1:L,x2:L+plotW,y1:y,y2:y},svgA);svgEl('text',{x:L-8,y:y+3.5,'text-anchor':'end'},svgA,compact(v));};
    const tTop=niceStep(maxFresh);if(tTop&&tTop*k>=14)grid(tTop,wl-G-tTop*k);
    const sBot=niceStep(maxCache/3);if(sBot&&sBot*k>=16)for(let v=sBot;v<=maxCache;v+=sBot)grid(v,wl+G+v*k);
    svgEl('text',{x:L-8,y:wl+3.5,'text-anchor':'end'},svgA,'0');
    if(tH>=28){svgEl('text',{class:'u-label strong',x:0,y:wl-tH/2-1},svgA,w('新增','New','新增'));svgEl('text',{class:'u-label small',x:0,y:wl-tH/2+12},svgA,w('未缓存 + 写入 + 输出','Uncached + write + output','未快取 + 寫入 + 輸出'));}
    else svgEl('text',{class:'u-label strong',x:0,y:wl-4},svgA,w('新增','New','新增'));
    if(bH>=28){svgEl('text',{class:'u-label strong',x:0,y:wl+bH/2-1},svgA,w('缓存读取','Cache read','快取讀取'));svgEl('text',{class:'u-label small',x:0,y:wl+bH/2+12},svgA,w('命中缓存的输入','Cached input','命中快取的輸入'));}
    else svgEl('text',{class:'u-label strong',x:0,y:wl+14},svgA,w('缓存读取','Cache read','快取讀取'));
    splits.forEach((s,i)=>{
      if(!buckets[i].total)return;const x=cx(i)-bw/2;
      if(s.fresh>0){const hf=Math.max(1.5,s.fresh*k);svgEl('path',{class:'u-fresh hx','data-bucket':i,d:roundEnd(x,wl-G-hf,bw,hf,3,true)},svgA);}
      if(s.cache>0){const hc=Math.max(1.5,s.cache*k),y0=wl+G;svgEl('path',{class:'u-cache-box hx','data-bucket':i,d:roundEnd(x,y0,bw,hc,3,false)},svgA);if(hc>3)svgEl('path',{class:'u-cache-hatch hx','data-bucket':i,d:hatchPath(x+.8,y0,x+bw-.8,y0+hc-.8)},svgA);}
    });
    svgEl('line',{class:'u-water',x1:L-4,x2:L+plotW+4,y1:wl,y2:wl},svgA);
    buckets.forEach((b,i)=>{if(!b.total&&b.from<=today)svgEl('circle',{class:'u-rest',cx:cx(i),cy:wl,r:2.2},svgA);});
    svgEl('text',{class:'u-side',x:L+plotW+12,y:wl-7},svgA,w('新增 ','New ','新增 ')+monoPct(sum.fresh,grand));
    svgEl('text',{class:'u-side',x:L+plotW+12,y:wl+16},svgA,w('缓存 ','Cache ','快取 ')+monoPct(sum.cache,grand));
    const peak=buckets.reduce((best,b,i)=>b.total>buckets[best].total?i:best,0);
    svgEl('text',{x:cx(peak),y:Math.max(10,wl-G-Math.max(1.5,splits[peak].fresh*k)-7),'text-anchor':'middle'},svgA,w('峰值 ','Peak ','峰值 ')+compact(buckets[peak].total));
    buckets.forEach((b,i)=>svgEl('text',{class:'u-x hx'+(monoTick(i,n)?' tick':''),'data-bucket':i,x:cx(i),y:bottom+18,'text-anchor':'middle'},svgA,monoLabel(b,i)));
    buckets.forEach((b,i)=>{const hit=svgEl('rect',{class:'u-hit','data-hit':'bucket','data-bucket':i,x:L+i*cell,y:0,width:cell,height:H,'aria-label':bucketLabel(b)+': '+full(b.total)+' Token'},svgA);if(b.from<=today)hit.setAttribute('tabindex','0');});
    // Punch card: one row per model (no color legend needed), circle area = tokens.
    const range=totals(buckets[0].from,buckets.at(-1).to,true),models=Object.entries(range.models).filter(([,r])=>r.total>0).sort((a,b)=>b[1].total-a[1].total);
    const ROW=22,rMax=Math.max(2.5,Math.min(cell/2-1.5,ROW/2-2)),maxCell=Math.max(1,...models.flatMap(([m])=>buckets.map(b=>b.models[m]?.total||0)));
    const rOf=v=>v>0?Math.max(1.8,rMax*Math.sqrt(v/maxCell)):0;
    const headB=node('div','mono-head'),leftB=node('div','');leftB.append(node('strong','',w('模型 × 时间 · 打孔卡','Model × time · punch card','模型 × 時間 · 打孔卡')),node('span','muted',w('圆面积代表 Token','Circle area = tokens','圓面積代表 Token')));
    const keyB=node('div','mono-key'),refs=[...new Set([niceStep(maxCell/100),niceStep(maxCell/10),niceStep(maxCell)])].filter(v=>v>0).sort((a,b)=>a-b);
    if(refs.length){let kx=0;const kh=Math.ceil(rMax*2)+2,keySvg=svgEl('svg',{height:kh,'aria-hidden':'true'});for(let idx=0;idx<refs.length;idx++){const v=refs[idx],r=rOf(v),lbl=compact(v),tw=Math.ceil(lbl.length*6.5)+4;kx+=r;svgEl('circle',{cx:kx,cy:kh/2,r,fill:'var(--pulse-foreground)'},keySvg);svgEl('text',{x:kx+r+4,y:kh/2+3.5},keySvg,lbl);kx+=r+4+tw+(idx<refs.length-1?10:2);}const kw=Math.max(1,Math.ceil(kx));keySvg.setAttribute('width',kw);keySvg.setAttribute('viewBox',`0 0 ${kw} ${kh}`);keyB.append(keySvg);}
    headB.append(leftB,keyB);
    const axisY=12,rowsTop=22,HB=rowsTop+models.length*ROW+6;
    const svgB=svgEl('svg',{class:'mono-svg punch',viewBox:`0 0 ${width} ${HB}`,width,height:HB,role:'img','aria-label':w('模型与时间打孔卡','Model by time punch card','模型與時間打孔卡')});
    svgEl('rect',{class:'u-band',x:0,y:0,width:cell,height:HB},svgB);
    buckets.forEach((b,i)=>svgEl('text',{class:'u-x hx'+(monoTick(i,n)?' tick':''),'data-bucket':i,x:cx(i),y:axisY,'text-anchor':'middle'},svgB,monoLabel(b,i)));
    svgEl('text',{class:'u-label small',x:width,y:axisY,'text-anchor':'end'},svgB,w('合计','Total','合計'));
    models.forEach(([model,r],j)=>{
      const yc=rowsTop+j*ROW+ROW/2,label=svgEl('text',{class:'u-label row hx','data-model':model,x:0,y:yc+4},svgB,shortName(modelName(model)));svgEl('title',{},label,fullModelName(model));
      svgEl('text',{x:width,y:yc+3.5,'text-anchor':'end'},svgB,compact(r.total));
      buckets.forEach((b,i)=>{const v=b.models[model]?.total||0;if(v>0)svgEl('circle',{class:'u-dot hx','data-bucket':i,'data-model':model,cx:cx(i),cy:yc,r:rOf(v).toFixed(2)},svgB);else if(b.from<=today)svgEl('circle',{class:'u-zero',cx:cx(i),cy:yc,r:1},svgB);});
    });
    buckets.forEach((b,i)=>svgEl('rect',{class:'u-hit','data-hit':'bucket','data-bucket':i,x:L+i*cell,y:0,width:cell,height:HB},svgB));
    models.forEach(([model],j)=>{const y=rowsTop+j*ROW;svgEl('rect',{class:'u-hit','data-hit':'row','data-model':model,x:0,y,width:L-10,height:ROW},svgB);
      buckets.forEach((b,i)=>{if(b.models[model]?.total>0)svgEl('rect',{class:'u-hit','data-hit':'cell','data-bucket':i,'data-model':model,x:L+i*cell,y,width:cell,height:ROW},svgB);});});
    restoringDom=true;
    try{monoWrap.replaceChildren(headA,svgA,headB,svgB);}finally{restoringDom=false;}
    if(chartWrap.scrollLeft!==savedLeft)chartWrap.scrollLeft=savedLeft;
    restoreScroll(body,savedTop);
    if(savedHover&&!restoreMonoHover(savedHover)){activeHover=null;hideTip();}
  }
  function monoSetHot(i,model,kind){
    for(const el of monoWrap.querySelectorAll('.hx')){
      const hasB=el.dataset.bucket!==undefined,hasM=el.dataset.model!==undefined;let on;
      if(hasB&&hasM)on=i!=null?(+el.dataset.bucket===i&&(model==null||el.dataset.model===model)):(model!=null&&el.dataset.model===model);
      else if(hasB)on=i!=null&&+el.dataset.bucket===i;
      else on=model!=null&&el.dataset.model===model;
      el.classList.toggle('on',on);
    }
    for(const band of monoWrap.querySelectorAll('.u-band')){band.classList.toggle('show',i!=null);if(i!=null&&monoGeo)band.setAttribute('x',monoGeo.L+i*monoGeo.cell);}
    monoWrap.classList.toggle('row-focus',kind==='row'||kind==='model');
  }
  function monoFocusModel(model){monoKey='';monoSetHot(null,model,model?'model':null);}
  function monoTip(i,model,target,clientX){
    const bucket=monoBuckets[i];if(!bucket)return;
    const same=!$('tip').hidden&&tipTarget===target&&tipModel===model;tipTarget=target;tipModel=model;
    if(!same){
      const s=monoSplit(bucket),tip=$('tip'),line=(label,amount,cls='')=>{const row=node('div','tip-model'+cls);row.append(node('span','',label),node('span','',amount));return row;};
      if(!bucket.total)tip.replaceChildren(node('div','tip-title',bucketLabel(bucket)),node('div','muted',w('无用量','No usage','無用量')));
      else{
        const input=s.uncached+s.cache+s.write;
        tip.replaceChildren(node('div','tip-title',bucketLabel(bucket)),node('strong','',full(bucket.total)+' Token'),node('div','muted',w(`${bucket.requests} 次请求`,`${bucket.requests} requests`,`${bucket.requests} 次請求`)),
          line(w('新增','New','新增'),compact(s.fresh)),node('div','tip-sub',`${w('未缓存','Uncached','未快取')} ${compact(s.uncached)} · ${w('写入','Write','寫入')} ${compact(s.write)} · ${w('输出','Output','輸出')} ${compact(s.output)}`),
          line(w('缓存读取','Cache read','快取讀取'),compact(s.cache)),line(w('缓存命中','Cache hit','快取命中'),monoPct(s.cache,input)),...(bucket.cost!==null?[line(w('换算金额','Est. cost','換算金額'),usd(bucket.cost))]:[]),node('div','tip-rule'));
        for(const [m,r]of Object.entries(bucket.models).filter(([,r])=>r.total>0).sort((a,b)=>b[1].total-a[1].total))tip.append(line(modelName(m),compact(r.total),model?(model===m?' active':' dimmed'):''));
      }
    }
    positionTip(target.getBoundingClientRect(),clientX);
  }
  function monoActivate(hit,clientX,viaFocus=false){
    const kind=hit.dataset.hit,i=hit.dataset.bucket!==undefined?+hit.dataset.bucket:null,model=hit.dataset.model||null,key=kind+':'+i+':'+model;
    activeHover={source:'mono',kind,bucket:i,model,chart:hit.closest('svg.punch')?'punch':'iceberg',clientX:typeof clientX==='number'&&Number.isFinite(clientX)?clientX:null,viaFocus};
    if(key!==monoKey){monoKey=key;monoSetHot(i,model,kind);}
    if(kind==='row'){if(!$('tip').hidden)hideTip();return;}
    monoTip(i,kind==='cell'?model:null,hit,clientX);
  }
  function restoreMonoHover(saved){
    if(!saved||saved.source!=='mono')return false;
    const svg=monoWrap.querySelector(saved.chart==='punch'?'svg.punch':'svg.iceberg');
    if(!svg)return false;
    let hit=null;
    for(const el of svg.querySelectorAll('[data-hit]')){
      if(el.dataset.hit!==saved.kind)continue;
      const eb=el.dataset.bucket!==undefined?+el.dataset.bucket:null,em=el.dataset.model||null;
      if(eb===saved.bucket&&em===saved.model){hit=el;break;}
    }
    if(!hit)return false;
    monoActivate(hit,saved.clientX,saved.viaFocus);
    if(saved.viaFocus&&hit.tabIndex>=0){restoringDom=true;try{hit.focus({preventScroll:true});}finally{restoringDom=false;}}
    return true;
  }
  function clearHover(){activeHover=null;monoKey='';monoSetHot(null,null,null);hideTip();}
  function monoClear(){if(restoringDom)return;if(activeHover?.source==='mono')activeHover=null;if(!monoKey)return;monoKey='';monoSetHot(null,null,null);hideTip();}
  function monoSelect(hit){const i=hit?.dataset.bucket;if(i===undefined)return;const bucket=monoBuckets[+i];if(bucket){selected=bucket;anchor=bucket.from;showSelection();}}
  monoWrap.addEventListener('pointermove',event=>{const hit=event.target.closest?.('[data-hit]');if(hit&&monoWrap.contains(hit))monoActivate(hit,event.clientX,false);else monoClear();});
  monoWrap.addEventListener('pointerleave',monoClear);
  monoWrap.addEventListener('focusin',event=>{const hit=event.target.closest?.('[data-hit]');if(hit)monoActivate(hit,null,true);});
  monoWrap.addEventListener('focusout',monoClear);
  monoWrap.addEventListener('click',event=>monoSelect(event.target.closest?.('[data-hit]')));
  monoWrap.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){const hit=event.target.closest?.('[data-hit]');if(hit){event.preventDefault();monoSelect(hit);}}});
  $('table-body').addEventListener('pointerleave',()=>{if(restoringDom)return;if(activeHover?.source==='table'){activeHover=null;highlightModel(null);hideTip();}});
  $('legend').addEventListener('pointerleave',()=>{if(restoringDom)return;if(activeHover?.source==='legend'){activeHover=null;highlightModel(null);}});
  $('heat').addEventListener('pointerleave',()=>{if(restoringDom)return;if(activeHover?.source==='heat'&&!activeHover.viaFocus){activeHover=null;hideTip();highlightModel(null);}});
  const monoResize=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(tab!=='details'||!dialog.open||!monoBuckets.length)return;const raw=Math.floor(chartWrap.clientWidth);if(!raw)return;const next=Math.max(600,raw);if(Math.abs(next-monoWidth)>8){renderMono(monoBuckets,{preserveHover:true});}}):null;
  monoResize?.observe(chartWrap);
  function renderChart({preserveHover=false}={}){
    if(!value)return;
    const body=$('page-body'),savedTop=body.scrollTop,savedHover=preserveHover&&activeHover?{...activeHover}:null;
    syncModels();if(!savedHover){activeHover=null;hideTip();highlightModel(null);}
    const buckets=[];
    if(period==='day'){const start=month(anchor,0),end=add(month(anchor,1),-1);for(let date=start;date<=end;date=add(date,1))buckets.push(totals(date,date,true));text('range-label',start.slice(0,7));}
    else if(period==='week'){const start=add(week(anchor),-11*7);for(let i=0;i<12;i++){const from=add(start,i*7);buckets.push(totals(from,add(from,6),true));}text('range-label',start.slice(5)+' – '+add(week(anchor),6).slice(5));}
    else{for(let i=-11;i<=0;i++){const from=month(anchor,i);buckets.push(totals(from,add(month(from,1),-1),true));}text('range-label',buckets[0].from.slice(0,7)+' – '+month(anchor,0).slice(0,7));}
    $('next').disabled=period==='week'?week(anchor)>=week(value.today):anchor.slice(0,7)>=value.today.slice(0,7);
    const legendButtons=mergedModelList.map(model=>{const button=node('button',''),dot=node('i','dot'),disp=modelName(model),fullLbl=fullModelName(model);button.append(dot,document.createTextNode(disp));if(fullLbl!==disp)button.title=fullLbl;button.type='button';button.dataset.model=model;button.setAttribute('aria-pressed',String(!disabledModels.has(model)));button.addEventListener('click',()=>{if(disabledModels.has(model))disabledModels.delete(model);else disabledModels.add(model);renderChart();});button.addEventListener('pointerenter',()=>{activeHover={source:'legend',model};highlightModel(disabledModels.has(model)?null:model);});button.addEventListener('pointerleave',()=>{if(restoringDom)return;if(activeHover?.source==='legend'&&activeHover.model===model)activeHover=null;highlightModel(null);});return button;});
    restoringDom=true;try{$('legend').replaceChildren(...legendButtons);}finally{restoringDom=false;}
    renderMono(buckets,{preserveHover:savedHover?.source==='mono'});
    $('table-head').replaceChildren(...[w('模型','Model','模型'),w('总 Token','Total tokens','總 Token'),w('未缓存输入','Uncached input','未快取輸入'),w('缓存读取','Cache read','快取讀取'),w('输出','Output','輸出'),w('缓存率','Cache hit','快取率'),w('换算金额','Est. cost','換算金額')].map(label=>node('th','',label)));
    const rangeTotals=totals(buckets[0].from,buckets.at(-1).to,true),refDate=buckets.at(-1)?.to||value?.today||'';
    const summaryNodes=[node('strong','',compact(rangeTotals.total)+' Token'),document.createTextNode(' · '+w(`${full(rangeTotals.requests)} 次请求`,`${full(rangeTotals.requests)} requests`,`${full(rangeTotals.requests)} 次請求`))];
    if(rangeTotals.cost!==null){
      const costSpan=node('span','summary-cost',' · '+w('约 ','≈ ','約 ')+shortUsd(rangeTotals.cost));
      costSpan.title=usd(rangeTotals.cost)+' · '+(rangeTotals.unpriced?w('按官网 API 标价换算（不含暂无标价的模型）','Estimated at official API list prices (excluding unpriced models)','按官網 API 標價換算（不含暫無標價的模型）'):w('按官网 API 标价换算','Estimated at official API list prices','按官網 API 標價換算'));
      summaryNodes.push(costSpan);
    }
    chartSummary.replaceChildren(...summaryNodes);
    let restoredRow=null;
    const rows=Object.entries(rangeTotals.models).sort((a,b)=>b[1].total-a[1].total).map(([model,r])=>{
      const row=node('tr',''),label=node('td',''),dot=node('span','dot'),disp=modelName(model),fullLbl=fullModelName(model);
      label.append(dot,document.createTextNode(disp));if(fullLbl!==disp)label.title=fullLbl;
      const inp=r.uncached+r.cacheRead+(r.cacheWrite||0),rate=inp>0?r.cacheRead/inp*100:null;
      const rateCell=node('td','col-rate');
      if(rate===null){rateCell.textContent='—';}
      else{const wrap=node('span','cache-rate'),bar=node('i','cache-bar'),fill=node('i','');fill.style.width=Math.max(0,Math.min(100,rate)).toFixed(1)+'%';bar.append(fill);wrap.append(bar,node('span','cache-pct',rate.toFixed(1)+'%'));rateCell.append(wrap);}
      const costCell=node('td','col-cost',r.priced?shortUsd(r.cost):'—');
      costCell.title=(r.priced?usd(r.cost)+'\n':'')+priceHint(modelPrice(model,refDate));
      const numCells=[r.total,r.uncached,r.cacheRead,r.output].map(n=>{const td=node('td','',shortNum(n));td.title=full(n)+' Token';return td;});
      row.append(label,...numCells,rateCell,costCell);row.dataset.model=model;
      const multiTier=Object.values(r.tiers||{}).filter(v=>v.total>0||v.requests>0).length>=2;
      if(savedHover?.source==='table'&&savedHover.model===model)restoredRow={row,r,multiTier};
      row.addEventListener('pointerenter',event=>{activeHover={source:'table',model,clientX:event.clientX};highlightModel(model);if(multiTier)tierTooltip(model,r,row,event.clientX,refDate);else hideTip();});
      row.addEventListener('pointerleave',()=>{if(restoringDom)return;if(activeHover?.source==='table'&&activeHover.model===model)activeHover=null;highlightModel(null);if(tipTarget===row)hideTip();});
      return row;
    });
    restoringDom=true;try{$('table-body').replaceChildren(...rows);}finally{restoringDom=false;}
    for(const b of view.querySelectorAll('[data-period]'))b.setAttribute('aria-pressed',String(b.dataset.period===period));
    if(savedHover?.source==='table'){
      if(restoredRow){activeHover=savedHover;highlightModel(savedHover.model);if(restoredRow.multiTier)tierTooltip(savedHover.model,restoredRow.r,restoredRow.row,savedHover.clientX,refDate);else hideTip();}
      else clearHover();
    }else if(savedHover?.source==='legend'){
      if(mergedModelList.includes(savedHover.model)){activeHover=savedHover;highlightModel(disabledModels.has(savedHover.model)?null:savedHover.model);}
      else clearHover();
    }
    restoreScroll(body,savedTop);
    lastScrollTop=body.scrollTop;
  }
  function render({preserveHover=false}={}){
    const body=$('page-body'),savedTop=body.scrollTop;
    renderGuide();
    if(!value){
      closeYear(false);clearHover();$('overview').hidden=true;$('details').hidden=true;$('usage-waiting').hidden=false;
      const sc=$('scope-controls');if(sc)sc.hidden=typeof onScope!=='function';
    text('usage-waiting',w('正在重新连接统计…','Reconnecting usage…','正在重新連線統計資料…'));text('subtitle',w('正在重新连接本机统计','Reconnecting local usage','正在重新連線本機統計'));text('coverage','');text('timezone','');$('alert').hidden=true;
      for(const metric of $('totals').children){metric.title='';metric.querySelector('.value')?.replaceChildren(node('span','','—'));}
      return;
    }
    $('usage-waiting').hidden=true;
    syncModels();
    const activeScope=pendingScope||(value.scope==='local'?'local':'account');
    text('title',w('用量统计','Token usage','用量統計'));dialog.setAttribute('aria-label',w('用量统计','Token usage','用量統計'));text('subtitle',activeScope==='local'?w(`本机 ${hostLabel} · 全部流经统计`,`Local ${hostLabel} · all local`,`本機 ${hostLabel} · 本機全部`):w(`本机 ${hostLabel} · 当前账号`,`Local ${hostLabel} · current account`,`本機 ${hostLabel} · 目前帳號`));
    const scopeControls=$('scope-controls');if(scopeControls){
      const hideControls=typeof onScope!=='function';
      if(scopeControls.hidden!==hideControls)scopeControls.hidden=hideControls;
      const scopeLabel=w('统计范围','Usage scope','統計範圍');
      if(scopeControls.getAttribute('aria-label')!==scopeLabel)scopeControls.setAttribute('aria-label',scopeLabel);
      if(scopeControls.dataset.activeScope!==activeScope)scopeControls.dataset.activeScope=activeScope;
      for(const b of scopeControls.querySelectorAll('button')){
        const k=b.dataset.usageScope,lbl=k==='local'?language.t('usageScopeLocal'):language.t('usageScopeAccount'),pressed=String(activeScope===k);
        if(b.textContent!==lbl)b.textContent=lbl;
        if(b.getAttribute('aria-pressed')!==pressed)b.setAttribute('aria-pressed',pressed);
      }
    }
    if(value.scope==='account'&&value.accountAvailable===false&&!scopeLoading){
      text('overview-tab',w('概览','Overview','概覽'));text('details-tab',w('详情','Details','詳細資料'));
      closeYear(false);clearHover();$('overview').hidden=true;$('details').hidden=true;$('usage-waiting').hidden=false;
      text('usage-waiting',w('当前未检测到登录账号，可切换到「本机全部」查看统计，或在 Antigravity 登录后重试。','No signed-in account detected. Switch to All local or sign in to view account usage.','目前未偵測到登入帳號，可切換至「本機全部」檢視統計，或於 Antigravity 登入後重試。'));
      languagePicker.update();for(const [id,label]of [['locale',language.t('language')],['refresh',w('刷新用量','Refresh usage','重新整理用量')],['close',w('关闭','Close','關閉')]]){$(id).setAttribute('aria-label',label);$(id).title=label;}
      for(const metric of $('totals').children){metric.title='';metric.querySelector('.value')?.replaceChildren(node('span','','—'));}
      text('coverage','');text('timezone','');$('alert').hidden=true;return;
    }
    text('overview-tab',w('活动概览','Activity','活動總覽'));text('details-tab',w('用量详情','Usage details','用量詳細資料'));text('activity-title',w('Token 活动','Token activity','Token 活動'));text('detail-title',w('按模型统计','Usage by model','依模型統計'));
    languagePicker.update();for(const [id,label]of [['locale',language.t('language')],['refresh',w('刷新用量','Refresh usage','重新整理用量')],['close',w('关闭','Close','關閉')]]){$(id).setAttribute('aria-label',label);$(id).title=label;}text('less',w('少','Less','少'));text('more',w('多','More','多'));text('selection-details',w('查看明细','View breakdown','檢視明細'));
    for(const b of view.querySelectorAll('[data-heat]'))b.textContent=b.dataset.heat==='day'?w('每天','Daily','每日'):w('每周','Weekly','每週');
    for(const b of view.querySelectorAll('[data-period]'))b.textContent=({day:w('天','Day','日'),week:w('周','Week','週'),month:w('月','Month','月')})[b.dataset.period];
    $('overview-tab').setAttribute('aria-selected',String(tab==='overview'));$('details-tab').setAttribute('aria-selected',String(tab==='details'));$('overview').hidden=tab!=='overview';$('details').hidden=tab!=='details';
    const fin=computeOverviewFinance();
    const metricCards=[
      [w('今日用量','Today','今日用量'),value.todayTokens,fin.todayCost],
      [w('本周用量','This week','本週用量'),value.weekTokens,fin.weekCost],
      [w('本月用量','This month','本月用量'),value.monthTokens,fin.monthCost],
      [w('累计用量','All time','累積用量'),value.totalTokens,fin.allCost],
    ].map(([label,total,cost])=>{
      const metric=node('div','metric'),n=node('div','value',compact(total));n.append(node('span','unit','Token'));metric.append(node('label','',label),n);
      metric.title=full(total)+' Token'+(cost!==null?' · '+w('约 ','≈ ','約 ')+usd(cost):'');
      return metric;
    });
    const spendCard=node('div','metric metric-cost'),spendVal=node('div','value',compactUsd(fin.allCost));
    if(fin.allCost!==null)spendVal.append(node('span','unit','USD'));
    spendCard.append(node('label','',w('累计金额','Total cost','累積金額')),spendVal);
    spendCard.title=fin.allCost!==null?(w('按官网 API 标价累计换算：','Cumulative estimate at official API list prices: ','按官網 API 標價累積換算：')+usd(fin.allCost)+' USD'+(fin.allUnpriced?w('（不含暂无标价的模型）',' (excluding unpriced models)','（不含暫無標價的模型）'):'')):w('暂无可换算的官网标价记录','No priced model usage recorded','暫無可換算的官網標價記錄');
    const weeklyCard=node('div','metric metric-est'),weeklyVal=node('div','value');
    if(fin.weeklyEst){
      weeklyVal.append(node('span','approx','≈'),document.createTextNode(compactUsd(fin.weeklyEst.totalUsd)),node('span','unit','USD'));
      const detail=fin.weeklyEst.pools.map(p=>`${p.label} ${w('约 ','≈ ','約 ')}${usd(p.usd)}`+(p.usedFraction!==null?w(`（已用 ${Math.round(p.usedFraction*100)}%${p.fullTokens?` · 满额约 ${compact(p.fullTokens)} Token`:''}）`,` (${Math.round(p.usedFraction*100)}% used${p.fullTokens?` · full ~${compact(p.fullTokens)} tokens`:''})`,`（已用 ${Math.round(p.usedFraction*100)}%${p.fullTokens?` · 滿額約 ${compact(p.fullTokens)} Token`:''}）`):'')).join(' · ');
      const costDirect=fin.weeklyEst.pools.some(p=>p.costBased);
      weeklyCard.title=(costDirect?w('按等效 API 成本与周额度进度推算：','Estimated weekly full quota from equivalent API cost & quota progress: ','按等效 API 成本與週額度進度推算：'):w('按近 7 天模型/缓存配比与周额度进度推算：','Estimated weekly full quota from recent model/cache mix & quota progress: ','按近 7 天模型/快取配比與週額度進度推算：'))+usd(fin.weeklyEst.totalUsd)+' USD · '+detail;
    }else{
      weeklyVal.textContent='—';
      weeklyCard.title=fin.waitingSamples?w('本周额度样本较少，消耗达到阈值后自动推算','Not enough weekly quota usage yet; estimates appear once usage crosses threshold','本週額度樣本較少，消耗達到門檻後自動推算'):w('需登录账号并同步周额度后推算','Sign in and sync weekly quota to estimate','需登入帳號並同步週額度後推算');
    }
    weeklyCard.append(node('label','',w('预测周额度','Est. weekly','預測週額度')),weeklyVal);
    metricCards.push(spendCard,weeklyCard);
    $('totals').replaceChildren(...metricCards);
    const years=[];const first=Number(value.firstDate?.slice(0,4)||value.today.slice(0,4)),currentYear=Number(value.today.slice(0,4)),minimum=Math.max(first,currentYear-10);for(let y=currentYear;y>=minimum;y--)years.push(y);
    if($('year').dataset.years!==years.join(',')){
      $('year-menu').replaceChildren(...years.map(y=>{const option=node('button','year-option');option.type='button';option.dataset.year=String(y);option.setAttribute('role','option');option.tabIndex=-1;
        setMarkup(option,'<span></span><svg class="year-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>');option.firstElementChild.textContent=String(y);
        option.addEventListener('click',()=>{year=String(y);syncYear();closeYear();renderHeat();});return option;}));$('year').dataset.years=years.join(',');
    }
    syncYear();
    text('coverage',w(`已记录 ${full(value.requests)} 次请求${value.firstDate?' · 始于 '+value.firstDate:''}`,`${full(value.requests)} requests recorded${value.firstDate?' · since '+value.firstDate:''}`,`已記錄 ${full(value.requests)} 次請求${value.firstDate?' · 起始於 '+value.firstDate:''}`));
    text('timezone',value.timeZone+' · '+(value.syncing||value.retryingConversations>0?w('正在同步历史…','Syncing history…','正在同步歷程記錄…'):w('本地统计','Local usage','本機統計')));
    const alerts=[];if(value.unknownRequests)alerts.push(w(`${value.unknownRequests} 次请求日期未知，共 ${compact(value.unknownTokens)} Token`,`${value.unknownRequests} undated requests · ${compact(value.unknownTokens)} tokens`,`${value.unknownRequests} 次請求日期未知，共 ${compact(value.unknownTokens)} Token`));
    const confirmedMissing=value.confirmedMissingConversations??(value.syncing?0:value.missingConversations);
    if(value.partialRequests||value.unreadableFiles||confirmedMissing>0&&!value.syncing||value.persistenceError)alerts.push(w('部分记录暂不可读取，用量可能不完整','Some records are unavailable; usage may be incomplete','部分記錄暫無法讀取，用量可能不完整'));
    $('alert').hidden=!alerts.length;text('alert',alerts.join(' · '));
    if(tab==='overview')renderHeat({preserveHover});else renderChart({preserveHover});
    restoreScroll(body,savedTop);
    lastScrollTop=body.scrollTop;
  }
  function changeTab(next){closeYear(false);clearHover();tab=next;lastScrollTop=0;$('page-body').scrollTop=0;render();}
  $('overview-tab').addEventListener('click',()=>changeTab('overview'));$('details-tab').addEventListener('click',()=>changeTab('details'));
  for(const button of view.querySelectorAll('[data-usage-scope]'))button.addEventListener('click',()=>{
    if(disposed||!onScope)return;
    const next=button.dataset.usageScope,currentScope=pendingScope||(value?.scope==='local'?'local':'account');
    if(!next||next===currentScope)return;
    pendingScope=next;
    const cached=scopeCache.get(next);
    if(cached){
      if(accountKey&&accountKey!==cached.accountKey){selected=null;disabledModels.clear();year=cached.today.slice(0,4);anchor=cached.today;}
      accountKey=cached.accountKey;value=cached;scopeLoading=false;delete page.dataset.scopeLoading;lastKey=contentKey(cached);render();animateScopeChange();
    }else{
      scopeLoading=true;page.dataset.scopeLoading='true';render();
    }
    void Promise.resolve(onScope(next)).then(()=>{
      if(!disposed&&pendingScope===next){pendingScope=null;scopeLoading=false;delete page.dataset.scopeLoading;if(dialog.open)render();}
    },()=>{
      if(!disposed&&pendingScope===next){pendingScope=null;scopeLoading=false;delete page.dataset.scopeLoading;if(dialog.open)render();}
    });
  });
  for(const b of view.querySelectorAll('[data-heat]'))b.addEventListener('click',()=>{heatMode=b.dataset.heat;renderHeat();});
  for(const b of view.querySelectorAll('[data-period]'))b.addEventListener('click',()=>{period=b.dataset.period;renderChart();});
  function syncYear(){
    text('year-label',String(year));$('year').setAttribute('aria-label',w('选择年份','Select year','選取年份')+' · '+year);$('year-menu').setAttribute('aria-label',w('年份','Year','年份'));
    for(const option of $('year-menu').children)option.setAttribute('aria-selected',String(option.dataset.year===String(year)));
  }
  function closeYear(restore=true){if(!$('year-menu').matches(':popover-open'))return;$('year-menu').hidePopover();$('year').setAttribute('aria-expanded','false');if(restore)$('year').focus({preventScroll:true});}
  function positionYear(){
    if(!$('year-menu').matches(':popover-open'))return;const menu=$('year-menu'),r=$('year').getBoundingClientRect(),bounds=dialog.getBoundingClientRect(),width=menu.offsetWidth,height=menu.offsetHeight;
    menu.style.left=Math.max(bounds.left+12,Math.min(r.right-width,bounds.right-width-12))+'px';const below=r.bottom+7;
    menu.style.top=(below+height<=bounds.bottom-12?below:Math.max(bounds.top+12,r.top-height-7))+'px';
  }
  function openYear(){
    clearHover();$('year-menu').showPopover();$('year').setAttribute('aria-expanded','true');positionYear();
    ($('year-menu').querySelector('[aria-selected=true]')||$('year-menu').firstElementChild)?.focus({preventScroll:true});
  }
  $('year').addEventListener('click',()=>{$('year-menu').matches(':popover-open')?closeYear():openYear();});
  $('year').addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();openYear();if(event.key==='Home')$('year-menu').firstElementChild?.focus();if(event.key==='End')$('year-menu').lastElementChild?.focus();}});
  $('year-menu').addEventListener('keydown',event=>{
    const options=[...$('year-menu').children],current=options.indexOf(view.activeElement);let next=null;
    if(event.key==='ArrowDown')next=Math.min(options.length-1,current+1);else if(event.key==='ArrowUp')next=Math.max(0,current-1);else if(event.key==='Home')next=0;else if(event.key==='End')next=options.length-1;
    if(next!==null){event.preventDefault();options[next]?.focus({preventScroll:true});}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeYear();}else if(event.key==='Tab')closeYear();
  });
  view.addEventListener('pointerdown',event=>{const path=event.composedPath();if(!path.includes($('year'))&&!path.includes($('year-menu')))closeYear(false);});
  $('page-body').addEventListener('scroll',()=>{const body=$('page-body'),moved=Math.abs(body.scrollTop-lastScrollTop)>=1;if(dialog.open&&dialog.matches(':popover-open')&&body.clientHeight>0&&body.scrollHeight>body.clientHeight)lastScrollTop=body.scrollTop;closeYear(false);if(!suppressScrollTipHide&&moved&&(activeHover||!$('tip').hidden))clearHover();},{passive:true});
  window.addEventListener('resize',positionYear);
  $('heat').addEventListener('keydown',event=>{
    const buttons=[...$('heat').children],index=buttons.indexOf(event.target);if(index<0)return;
    const delta=heatMode==='day'?{ArrowLeft:-7,ArrowRight:7,ArrowUp:-1,ArrowDown:1}:{ArrowLeft:-1,ArrowRight:1,ArrowUp:-Math.ceil(buttons.length/2),ArrowDown:Math.ceil(buttons.length/2)};
    let next=event.key==='Home'?buttons.findIndex(b=>!b.disabled):event.key==='End'?buttons.findLastIndex(b=>!b.disabled):index+(delta[event.key]??NaN);
    if(!Number.isFinite(next)||next<0||next>=buttons.length||buttons[next].disabled)return;event.preventDefault();event.target.tabIndex=-1;buttons[next].tabIndex=0;buttons[next].focus();
  });
  $('selection-details').addEventListener('click',()=>{anchor=(selected?.from||value.today);period=heatMode;changeTab('details');});
  for(const [id,step]of [['previous',-1],['next',1]])$(id).addEventListener('click',()=>{anchor=period==='day'?month(anchor,step):period==='week'?add(anchor,step*84):month(anchor,step*12);renderChart();});
  const languagePicker=language.mountLanguagePicker({button:$('locale'),label:$('locale-label'),parent:dialog,choose:onLanguage});
  $('refresh').addEventListener('click',async()=>{
    if(busy||disposed)return;busy=true;const button=$('refresh'),turn=600,started=performance.now();button.disabled=true;button.setAttribute('aria-busy','true');
    refreshMotion=button.querySelector('svg').animate([{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}],{duration:turn,iterations:Infinity});
    try{await onRefresh();}
    catch{if(!disposed){text('alert',w('暂时无法刷新，请稍后重试','Refresh unavailable. Try again shortly.','暫時無法重新整理，請稍後重試'));$('alert').hidden=false;}}
    finally{
      // Fast requests still paint one whole turn. Slow requests finish their
      // current turn, so cancel never snaps a half-rotated icon back to zero.
      if(!disposed){const elapsed=performance.now()-started,remaining=Math.max(turn,Math.ceil(elapsed/turn)*turn)-elapsed;
        await new Promise(resolve=>{finishRefresh=resolve;refreshDelay=setTimeout(resolve,Math.max(0,remaining));});}
      clearTimeout(refreshDelay);refreshDelay=null;finishRefresh=null;refreshMotion?.cancel();refreshMotion=null;busy=false;
      if(!disposed){button.disabled=false;button.setAttribute('aria-busy','false');}
    }
  });
  // Native showModal()/close() changes inertness across the complete host DOM.
  // In long chats this alone can block Chromium for seconds. A top-layer
  // popover keeps the same backdrop without touching every background node.
  // Contain pointer, focus, Tab, Escape and scrolling explicitly instead.
  function present(){
    if(dialog.matches(':popover-open'))return;
    dialog.removeAttribute('open');dialog.showPopover();dialog.setAttribute('open','');
    $('locale').focus({preventScroll:true});
  }
  function conceal(){
    if(dialog.matches(':popover-open'))dialog.hidePopover();dialog.removeAttribute('open');
  }
  function close(){languagePicker.close(false);closeYear(false);clearHover();conceal();opener?.focus({preventScroll:true});}
  $('close').addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close();}});
  const weeklyQuotaSig=data=>{const qw=data?.quotaWindows;if(!qw||typeof qw!=='object')return '';return Object.entries(qw).filter(([k])=>k.endsWith(':weekly')).sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>`${k}:${Math.round(v?.estimatedFullTokens||0)}`).join('|');};
  const contentKey=data=>JSON.stringify([{...data,updatedAt:undefined,quotaWindows:undefined,activeAccountKey:undefined,status:undefined,summaryStale:undefined},weeklyQuotaSig(data),language.language,themeSignature(),typeof onScope==='function',pendingScope,scopeLoading]);
  const within=event=>event.composedPath().includes(dialog);
  function containFocus(event){if(!disposed&&dialog.open&&!within(event)){$('locale').focus({preventScroll:true});}}
  function containKeys(event){
    if(disposed||!dialog.open)return;
    if(event.key==='Escape'){
      event.preventDefault();event.stopImmediatePropagation();
      if($('year-menu').matches(':popover-open'))closeYear();else close();return;
    }
    if(event.key!=='Tab')return;
    // The year menu retains its own Tab dismissal; focus stays in the dialog.
    if($('year-menu').matches(':popover-open'))closeYear(false);
    const controls=[...view.querySelectorAll('button,input,select,a[href],[tabindex]')].filter(n=>n.tabIndex>=0&&!n.disabled&&n.getClientRects().length&&getComputedStyle(n).visibility!=='hidden');
    if(!controls.length){event.preventDefault();return;}
    const index=controls.indexOf(view.activeElement);
    if(index<0||event.shiftKey&&index===0||!event.shiftKey&&index===controls.length-1){
      event.preventDefault();event.stopImmediatePropagation();(event.shiftKey?controls.at(-1):controls[0]).focus({preventScroll:true});
    }
  }
  function containScroll(event){if(!disposed&&dialog.open&&!within(event))event.preventDefault();}
  function containPointer(event){
    if(disposed||!dialog.open)return;
    const r=dialog.getBoundingClientRect();
    const backdropHit=event.composedPath()[0]===dialog;
    if(!within(event)||backdropHit&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)){event.preventDefault();event.stopImmediatePropagation();if(event.type==='click')close();}
  }
  document.addEventListener('focusin',containFocus,true);document.addEventListener('keydown',containKeys,true);
  document.addEventListener('wheel',containScroll,{capture:true,passive:false});document.addEventListener('touchmove',containScroll,{capture:true,passive:false});
  for(const type of ['pointerdown','mousedown','click'])document.addEventListener(type,containPointer,true);
  // CSS surfaces update immediately; JS model colors must follow in the same
  // theme change, rather than waiting for the next metrics poll.
  const themeObserver=new MutationObserver(()=>{if(!disposed&&value&&dialog.open){const key=contentKey(value);if(key!==lastKey){lastKey=key;render({preserveHover:true});}}});
  if(root.host)themeObserver.observe(root.host,{attributes:true,attributeFilter:['data-pulse-theme','style']});
  return {
    open(data,trigger){
      if(!data||disposed)return;
      if(data.scope==='local'||data.scope==='account')scopeCache.set(data.scope,data);
      pendingScope=null;scopeLoading=false;delete page.dataset.scopeLoading;
      accountKey=data.accountKey;value=data;opener=trigger;year||=data.today.slice(0,4);anchor||=data.today;lastKey=contentKey(data);clearHover();lastScrollTop=0;$('page-body').scrollTop=0;render();present();
    },
    update(data){
      if(disposed)return;
      if(!data){if(!value)return;value=null;lastKey='';if(dialog.open)render();return;}
      if(data.scope==='local'||data.scope==='account')scopeCache.set(data.scope,data);
      if(pendingScope){
        if(data.scope!==pendingScope)return;
        const wasLoading=scopeLoading;
        pendingScope=null;scopeLoading=false;delete page.dataset.scopeLoading;
        if(accountKey&&accountKey!==data.accountKey){selected=null;disabledModels.clear();year=data.today.slice(0,4);anchor=data.today;}
        accountKey=data.accountKey;value=data;if(!dialog.open)return;lastKey=contentKey(data);render();
        if(wasLoading)animateScopeChange();
        return;
      }
      const accountChanged=Boolean(accountKey&&accountKey!==data.accountKey);if(accountChanged){selected=null;disabledModels.clear();year=data.today.slice(0,4);anchor=data.today;}accountKey=data.accountKey;value=data;if(!dialog.open)return;const key=contentKey(data);if(key===lastKey)return;lastKey=key;render({preserveHover:!accountChanged});
    },
    restoreModal(){if(!disposed&&dialog.open&&dialog.isConnected&&!dialog.matches(':popover-open')){const top=lastScrollTop;closeYear(false);present();if(top>0)$('page-body').scrollTop=top;}},
    close,syncGuideDismissed(){if(!replayGuide)dismissGuide();},dispose(){disposed=true;monoResize?.disconnect();languagePicker.dispose();themeObserver.disconnect();clearTimeout(refreshDelay);finishRefresh?.();refreshMotion?.cancel();for(const anim of scopeAnimations)anim.cancel();scopeAnimations=[];closeYear(false);window.removeEventListener('resize',positionYear);document.removeEventListener('focusin',containFocus,true);document.removeEventListener('keydown',containKeys,true);document.removeEventListener('wheel',containScroll,true);document.removeEventListener('touchmove',containScroll,true);for(const type of ['pointerdown','mousedown','click'])document.removeEventListener(type,containPointer,true);conceal();dialog.remove();backdrop.remove();},get isOpen(){return dialog.open;}};
};
