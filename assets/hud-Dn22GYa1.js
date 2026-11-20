import{m as B,G as I,H as G,p as $,i as d,s as L,l as k,g as E,r as P,a as U,c as f,b as s,d as q,e as N,f as R}from"./views-Ce78zkXd.js";const g=()=>d(s())||U();try{navigator.mediaDevices&&(navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException("HUD 수신기 모드: 마이크를 사용하지 않습니다","NotAllowedError")),navigator.mediaDevices.getDisplayMedia=()=>Promise.reject(new DOMException("HUD 수신기 모드: 화면/오디오 캡처를 사용하지 않습니다","NotAllowedError")))}catch{}const a=e=>document.getElementById(e),C="lm.rxCode",j=e=>{try{return localStorage.getItem(e)??""}catch{return""}},T=(e,t)=>{try{localStorage.setItem(e,t)}catch{}};a("app").innerHTML=`
  <header>
    <h1>G2 HUD 수신기 <small>RECEIVER</small></h1>
    <div class="rxcode"><span>연결 코드</span><b id="rxCode">----</b><button id="changeCode" class="small" type="button">코드 변경</button></div>
    <div id="status" class="status">시작 중…</div>
  </header>
  <div id="pcWarn" hidden>⚠️ PC 신호 대기중</div>
  <div id="conn" class="badge off">🔴 대기 중</div>
  <section class="card">
    <div id="hud">
      <div id="hudCd" class="hud-cd" hidden></div>
      <div class="hud-line fb" id="hud0"></div><div class="hud-line" id="hud1"></div><div class="hud-line" id="hud2"></div>
      <div class="hud-line" id="hud3"></div><div class="hud-line" id="hud4"></div>
    </div>
    <div id="g2" class="hint">G2 렌즈: 브리지 확인 중…</div>
  </section>
  <div id="genreBadge" class="badge genre">🎵 장르 판별 대기 중</div>
  <section class="card">
    <h2>스테레오 레벨 미터 <small>-60 ~ 0 dBFS · PC 분석기</small></h2>
    <div id="meters">${B()}</div>
  </section>
  <section class="card">
    <h2>밴드 분석 <small id="bandInfo">PC 분석기 실시간</small></h2>
    <table id="bandTable"></table>
    <div id="aiLast" class="hint"></div>
  </section>
  <section class="card">
    <div id="remoteStatus" class="hint"></div>
    <div class="hint">PC 분석기 화면 맨 위의 4자리 연결 코드를 입력하면 자동으로 연결됩니다. 네트워크가 달라도(PC 유선 LAN ↔ 폰 LTE) 됩니다.</div>
    <div id="buildInfo" class="hint"></div>
  </section>`;const l=new I;let h=null,b=0;function F(e){T(C,e),b=Date.now(),L(e),a("rxCode").textContent=e;try{const t=new URL(location.href);t.searchParams.set("mode","hud"),t.searchParams.set("code",e),history.replaceState(null,"",t.toString())}catch{}y()}function S(){if(document.getElementById("keypad"))return;let e="";const t=document.createElement("div");t.id="keypad",t.className="keypad";const o=["1","2","3","4","5","6","7","8","9","del","0","cancel"];t.innerHTML=`
    <h2>PC 분석기의 연결 코드 4자리</h2>
    <div class="kp-disp">${"<span></span>".repeat(4)}</div>
    <div class="kp-grid">${o.map(n=>`<button type="button" data-k="${n}">${n==="del"?"⌫":n==="cancel"?"취소":n}</button>`).join("")}</div>
    <div class="kp-msg"></div>`,document.body.appendChild(t);const c=t.querySelector('[data-k="cancel"]');c.disabled=!d(s());const u=()=>t.querySelectorAll(".kp-disp span").forEach((n,m)=>{n.textContent=e[m]??""}),v=()=>{t.remove(),window.removeEventListener("keydown",p)},r=n=>{if(n==="cancel"){d(s())&&v();return}if(n==="del"?e=e.slice(0,-1):/^\d$/.test(n)&&e.length<4&&(e+=n),u(),e.length===4){t.querySelector(".kp-msg").textContent=`${e} 로 연결 중…`;const m=e;setTimeout(()=>{v(),F(m)},150)}},p=n=>{/^\d$/.test(n.key)?r(n.key):n.key==="Backspace"?r("del"):n.key==="Escape"&&r("cancel")};t.querySelectorAll("button[data-k]").forEach(n=>{n.onclick=()=>r(n.dataset.k)}),window.addEventListener("keydown",p),u()}a("changeCode").onclick=S;let w="";function D(e){const t=e.join(`
`);t!==w&&(w=t,N(e),l.update(e))}function O(e,t){D(k(e,t)),a("genreBadge").textContent=e.genre?E(e.genre,e.genreAt):"🎵 장르 판별 대기 중",P(a("bandTable"),e.bands),a("aiLast").textContent=e.aiLog?`[${f(e.aiLog.at)}] ${e.aiLog.text}`:"",a("remoteStatus").textContent=e.status?`분석기 상태: ${e.status}`:"",h=e.levels,M(e,t)}function M(e,t){const o=e.running&&t.phase!=="stopped"&&!(t.lastHb!==null&&!t.pcAlive)?e.cooldownCount??0:0;$(o),l.setCooldownCount(o)}l.onTap=()=>{if(!g())return;i.sendCommand("resetCooldown");const e=a("status");e.textContent="👓 터치: 쿨다운 초기화 요청을 보냈습니다",$(0),l.setCooldownCount(0)};function H(e){const t=a("pcWarn"),c=g()&&!e.pcAlive&&(e.lastHb!==null||Date.now()-b>q);t.hidden=!c,c&&(t.textContent=e.lastHb?`⚠️ PC 신호 대기중 · 마지막 신호 ${f(e.lastHb)}`:e.local?"⚠️ 분석기 신호 대기중 · 같은 폰의 Live Mix 앱에서 [시작]을 눌러 주세요":`⚠️ PC 신호 대기중 · 코드 ${s()} 의 PC 분석기가 아직 응답하지 않습니다`)}function x(e){const t=a("conn"),o=e.lastUpdate?f(e.lastUpdate):"",c=e.mqtt==="on"?"MQTT 연결됨":e.mqtt==="connecting"?"MQTT 연결 중…":"MQTT 사용 불가",u=e.pcAlive&&e.hbLevelDb!==null?` · PC 입력 ${e.hbLevelDb<=-100?"-∞":e.hbLevelDb.toFixed(0)}dB`:"",v={live:["live",`🟢 실시간 수신 중 (마지막 업데이트: ${o})${u}`],stale:["stale",`🟡 신호 지연 — PC 분석기 응답 없음 (마지막 업데이트: ${o})`],stopped:["off",`⏸ PC 분석기 정지됨 (마지막 업데이트: ${o})`],waiting:["off",e.local?"🔴 대기 중 — 같은 폰 Live Mix 앱의 분석 시작을 기다리는 중":d(s())?`🔴 대기 중 — 코드 ${s()} 의 PC 분석기 데이터를 기다리는 중`:"🔴 연결 코드를 입력하세요 (같은 폰의 Live Mix 앱을 찾는 중…)"]},[r,p]=v[e.phase];t.className=`badge ${r}`,t.textContent=p,a("status").textContent=`${e.local?"📱 같은 폰 앱과 자동 연결됨 (코드 불필요) · ":""}${c}${d(s())?` · 코드 ${s()}`:""}`,e.local&&document.getElementById("keypad")?.remove(),e.local&&!d(s())&&(a("rxCode").textContent="📱자동"),H(e)}const i=new G({announce:!0});i.onUpdate=(e,t)=>{O(e,t),x(t)};i.onLevels=e=>{h=e};i.onInfo=e=>{x(e),y()};{const e=new URLSearchParams(location.search).get("code")??"",t=d(e)?e:j(C);d(t)&&(T(C,t),b=Date.now(),L(t),a("rxCode").textContent=t)}i.start();d(s())||setTimeout(()=>{g()||S()},2500);function y(){const e=i.info();H(e);const t=i.state;t&&(D(k(t,e)),M(t,e),e.phase!=="live"&&(h=null))}setInterval(()=>{y(),x(i.info())},1e3);function A(){R(a("meters"),h),requestAnimationFrame(A)}requestAnimationFrame(A);setInterval(()=>{const e=i.state;e&&e.genre&&(a("genreBadge").textContent=E(e.genre,e.genreAt))},1e3);P(a("bandTable"),null);a("buildInfo").textContent="빌드: 2026. 11. 20. PM 12:59:14";l.onState=(e,t)=>{a("g2").textContent=e==="ready"?"G2 렌즈: 연결됨 (Even Hub 브리지 · 5줄 컨테이너)":e==="text-fallback"?"G2 렌즈: 연결됨 (브리지 텍스트 전송 방식)":e==="failed"?`G2 렌즈: 출력 실패 (${t??""})`:"G2 렌즈: 브리지 확인 중…"};setTimeout(()=>{l.state==="waiting"&&(a("g2").textContent="G2 렌즈: 브리지 대기 중 (Even 앱 밖의 일반 브라우저에서는 렌즈 출력 없음)")},4e3);l.init();
