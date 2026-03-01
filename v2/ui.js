// ui.js (v2 bootstrap) - FIXED
// 목적: game.js가 기대하는 DOM(id들)을 #ui-root 아래에 생성한다.
// game.js보다 먼저 로드되어야 함.

(function(){
  if(window.__UI_BOOTSTRAPPED_V2__) return;
  window.__UI_BOOTSTRAPPED_V2__ = true;

  const root = document.getElementById("ui-root");
  if(!root) return;

  // 이미 있으면 중복 생성 방지
  if(document.getElementById("ui")) return;

  root.innerHTML = `
    <!-- HUD / Controls -->
    <div id="ui">
      <div id="movePad"><div id="stick"></div></div>

      <div id="specText"></div>

      <div style="display:flex; gap:12px; align-items:center;">
        <button id="btnEquip" type="button" aria-label="Equip">E</button>
        <button id="btnBag" type="button" aria-label="Bag">B</button>
        <button id="miniBagBtn" type="button" aria-label="Mini Bag">🎒</button>

        <button id="lootBtn" type="button" aria-label="Loot">L</button>

        <button id="attackBtn" type="button" aria-label="Attack">
          <!-- game.js가 getContext()를 쓰므로 canvas로 제공 -->
          <canvas id="attackIcon" width="64" height="64"></canvas>
        </button>
      </div>
    </div>

    <div id="lootToast" style="display:none;"></div>

    <!-- Loot choice overlay -->
    <div id="lootOverlay" style="display:none;">
      <div id="lootCards"></div>
    </div>

    <!-- Equip overlay -->
    <div id="equipOverlay" style="display:none;">
      <div class="panelHead">
        <button id="btnEquipClose" type="button">X</button>
        <div class="title">장비</div>
      </div>
      <div id="equipSlots"></div>
      <div id="equipInfo"></div>

      <div class="panelFoot">
        <button id="btnEquipToBag" type="button">가방</button>
        <button id="btnEquipCraft" type="button">제작</button>
        <button id="btnEquipUnequip" type="button">해제</button>
      </div>
    </div>

    <!-- Bag overlay -->
    <div id="bagOverlay" style="display:none;">
      <div class="panelHead">
        <button id="btnBagClose" type="button">X</button>
        <div class="title">가방</div>
      </div>

      <div id="bagGrid"></div>
      <div id="bagInfo"></div>

      <div class="panelFoot">
        <button id="btnBagToEquip" type="button">장비</button>
        <button id="btnBagCraft" type="button">제작</button>
        <button id="btnBagEquip" type="button">장착</button>
      </div>
    </div>

    <!-- Craft overlay -->
    <div id="craftOverlay" style="display:none;">
      <div class="panelHead">
        <button id="btnCraftClose" type="button">X</button>
        <div class="title">제작</div>
      </div>

      <div class="craftTop">
        <!-- game.js가 getContext()를 쓰므로 canvas로 제공 -->
        <canvas id="craftItemIcon" width="96" height="96"></canvas>
        <div id="craftItemText"></div>
      </div>

      <div id="metaCraftBox"></div>

      <div id="craftOrbGrid">
        <button id="orbTransmute" type="button">변화</button>
        <button id="orbAlter" type="button">수정</button>
        <button id="orbAug" type="button">증강</button>
        <button id="orbRegal" type="button">제왕</button>
        <button id="orbAlchemy" type="button">연금</button>
        <button id="orbScour" type="button">초기화</button>
        <button id="orbAnnul" type="button">제거</button>
        <button id="orbExalt" type="button">승격</button>
        <button id="orbDivine" type="button">신성</button>
        <button id="orbCorrupt" type="button">타락</button>
      </div>

      <div id="orbDesc"></div>
      <div id="orbCounts"></div>

      <div class="panelFoot">
        <button id="btnCraftToEquip" type="button">장비</button>
        <button id="btnCraftToBag" type="button">가방</button>
        <button id="btnCraftApply" type="button">적용</button>
        <button id="btnLockPrefix" type="button">접두 고정</button>
        <button id="btnLockSuffix" type="button">접미 고정</button>
        <button id="btnRemoveMeta" type="button">메타 제거</button>
        <button id="chaosBtn" type="button">카오스</button>
      </div>
    </div>

    <!-- Fatal error overlay (game.js가 보여줌) -->
    <div id="fatalErrorOverlay" style="display:none;"></div>
  `;

  // 버튼 타입 기본값
  try{
    root.querySelectorAll("button").forEach(b=>{ if(!b.getAttribute("type")) b.setAttribute("type","button"); });
  }catch(_){}
})();

// ===== v2: input binding (UI -> Game) =====
(function(){
  if(window.__UI_V2_INPUT_BIND__) return;
  window.__UI_V2_INPUT_BIND__ = true;

  function el(id){ try{ return (window.UI && UI.el) ? UI.el(id) : document.getElementById(id); }catch(_){ return null; } }

  const pad = el("movePad");
  const stick = el("stick");
  const atk = el("attackBtn");
  const loot = el("lootBtn");

  // ----- joystick -----
  let active = false;
  let pid = null;

  function setStick(nx, ny){
    if(!pad || !stick) return;
    const r = pad.getBoundingClientRect();
    const cx = r.width/2, cy = r.height/2;
    const max = Math.min(cx, cy) - 4;
    const x = cx + nx*max;
    const y = cy + ny*max;
    stick.style.left = (x - stick.offsetWidth/2) + "px";
    stick.style.top  = (y - stick.offsetHeight/2) + "px";
  }

  function joyFromEvent(e){
    const r = pad.getBoundingClientRect();
    const cx = r.left + r.width/2;
    const cy = r.top + r.height/2;
    const dx = (e.clientX - cx);
    const dy = (e.clientY - cy);
    const max = Math.min(r.width, r.height) * 0.45;
    const nx = Math.max(-1, Math.min(1, dx / max));
    const ny = Math.max(-1, Math.min(1, dy / max));
    return {nx, ny};
  }

  function joyUpdate(e){
    if(!active || !pad) return;
    e.preventDefault?.();
    const {nx, ny} = joyFromEvent(e);
    setStick(nx, ny);
    try{ window.Game && Game.setJoy && Game.setJoy(nx, ny); }catch(_){}
  }

  function joyEnd(){
    active = false;
    pid = null;
    setStick(0,0);
    try{ window.Game && Game.setJoy && Game.setJoy(0,0); }catch(_){}
  }

  if(pad){
    pad.style.touchAction = "none";
    pad.addEventListener("pointerdown", (e)=>{
      active = true; pid = e.pointerId;
      pad.setPointerCapture?.(pid);
      joyUpdate(e);
    }, {passive:false});

    window.addEventListener("pointermove", (e)=>{ if(active && (pid==null || e.pointerId===pid)) joyUpdate(e); }, {passive:false});
    window.addEventListener("pointerup", (e)=>{ if(active && (pid==null || e.pointerId===pid)) joyEnd(); }, {passive:true});
    window.addEventListener("pointercancel", (e)=>{ if(active && (pid==null || e.pointerId===pid)) joyEnd(); }, {passive:true});
  }

  // ----- attack -----
  function atkOn(e){ e.preventDefault?.(); try{ window.Game && Game.setAttack && Game.setAttack(true); }catch(_){} }
  function atkOff(e){ e && e.preventDefault?.(); try{ window.Game && Game.setAttack && Game.setAttack(false); }catch(_){} }
  if(atk){
    atk.style.touchAction = "none";
    atk.addEventListener("pointerdown", atkOn, {passive:false});
    window.addEventListener("pointerup", atkOff, {passive:true});
    window.addEventListener("pointercancel", atkOff, {passive:true});
  }

  // ----- loot -----
  if(loot){
    loot.style.touchAction = "none";
    loot.addEventListener("pointerdown", (e)=>{ e.preventDefault?.(); try{ window.Game && Game.pressLoot && Game.pressLoot(); }catch(_){} }, {passive:false});
  }
})();

// ===== UI Bridge (v2 Step2) =====
window.UI = window.UI || (function(){
  const api = {
    el(id){ return document.getElementById(id); },
    qs(sel, root=document){ try{ return root.querySelector(sel); }catch(_){ return null; } },
    qsa(sel, root=document){ try{ return Array.from(root.querySelectorAll(sel)); }catch(_){ return []; } },
    show(id){ const e = api.el(id); if(e) e.style.display = "block"; },
    hide(id){ const e = api.el(id); if(e) e.style.display = "none"; },
    toggle(id, on){ (on ? api.show : api.hide)(id); },
    text(id, t){ const e = api.el(id); if(e) e.textContent = (t ?? ""); },
    html(id, h){ const e = api.el(id); if(e) e.innerHTML = (h ?? ""); },
    ctx(id){ const c = api.el(id); return (c && c.getContext) ? c.getContext("2d") : null; },
    on(id, evt, fn, opt){ const e = api.el(id); if(!e) return false; e.addEventListener(evt, fn, opt); return true; }
  };
  return api;
})();

// ===== v2: input binding (UI -> Game) =====
(function(){
  if(window.__UI_V2_INPUT_BIND__) return;
  window.__UI_V2_INPUT_BIND__ = true;

  function el(id){ try{ return (window.UI && UI.el) ? UI.el(id) : document.getElementById(id); }catch(_){ return null; } }

  const pad = el("movePad");
  const stick = el("stick");
  const atk = el("attackBtn");
  const loot = el("lootBtn");

  // ----- joystick -----
  let active = false;
  let pid = null;

  function setStick(nx, ny){
    if(!pad || !stick) return;
    const r = pad.getBoundingClientRect();
    const cx = r.width/2, cy = r.height/2;
    const max = Math.min(cx, cy) - 4;
    const x = cx + nx*max;
    const y = cy + ny*max;
    stick.style.left = (x - stick.offsetWidth/2) + "px";
    stick.style.top  = (y - stick.offsetHeight/2) + "px";
  }

  function joyFromEvent(e){
    const r = pad.getBoundingClientRect();
    const cx = r.left + r.width/2;
    const cy = r.top + r.height/2;
    const dx = (e.clientX - cx);
    const dy = (e.clientY - cy);
    const max = Math.min(r.width, r.height) * 0.45;
    const nx = Math.max(-1, Math.min(1, dx / max));
    const ny = Math.max(-1, Math.min(1, dy / max));
    return {nx, ny};
  }

  function joyUpdate(e){
    if(!active || !pad) return;
    e.preventDefault?.();
    const {nx, ny} = joyFromEvent(e);
    setStick(nx, ny);
    try{ window.Game && Game.setJoy && Game.setJoy(nx, ny); }catch(_){}
  }

  function joyEnd(){
    active = false;
    pid = null;
    setStick(0,0);
    try{ window.Game && Game.setJoy && Game.setJoy(0,0); }catch(_){}
  }

  if(pad){
    pad.style.touchAction = "none";
    pad.addEventListener("pointerdown", (e)=>{
      active = true; pid = e.pointerId;
      pad.setPointerCapture?.(pid);
      joyUpdate(e);
    }, {passive:false});

    window.addEventListener("pointermove", (e)=>{ if(active && (pid==null || e.pointerId===pid)) joyUpdate(e); }, {passive:false});
    window.addEventListener("pointerup", (e)=>{ if(active && (pid==null || e.pointerId===pid)) joyEnd(); }, {passive:true});
    window.addEventListener("pointercancel", (e)=>{ if(active && (pid==null || e.pointerId===pid)) joyEnd(); }, {passive:true});
  }

  // ----- attack -----
  function atkOn(e){ e.preventDefault?.(); try{ window.Game && Game.setAttack && Game.setAttack(true); }catch(_){} }
  function atkOff(e){ e && e.preventDefault?.(); try{ window.Game && Game.setAttack && Game.setAttack(false); }catch(_){} }
  if(atk){
    atk.style.touchAction = "none";
    atk.addEventListener("pointerdown", atkOn, {passive:false});
    window.addEventListener("pointerup", atkOff, {passive:true});
    window.addEventListener("pointercancel", atkOff, {passive:true});
  }

  // ----- loot -----
  if(loot){
    loot.style.touchAction = "none";
    loot.addEventListener("pointerdown", (e)=>{ e.preventDefault?.(); try{ window.Game && Game.pressLoot && Game.pressLoot(); }catch(_){} }, {passive:false});
  }

// ---- v2 UI watchdog: 패널(인벤/장비/제작) 닫고 돌아왔는데 HUD가 사라지는 케이스 방지 ----
(function(){
  if(window.__UI_V2_WATCHDOG__) return;
  window.__UI_V2_WATCHDOG__ = true;

  function isShown(el){
    if(!el) return false;
    // style.display 체크 + DOM 연결 체크
    const ds = (el.style && el.style.display) || "";
    if(ds === "none") return false;
    return !!(el.offsetParent || el.getClientRects().length);
  }

  function tick(){
    try{
      const body = document.body;
      const hud  = document.getElementById("ui");
      const eq   = document.getElementById("equipOverlay");
      const bag  = document.getElementById("bagOverlay");
      const cr   = document.getElementById("craftOverlay");

      const anyPanel = isShown(eq) || isShown(bag) || isShown(cr);
      const panelOpen = body.classList.contains("panel-open");

      // 패널이 안 보이는데 panel-open 클래스가 남아있으면 강제 복구
      if(panelOpen && !anyPanel){
        if(typeof window.closePanels === "function") window.closePanels();
        else body.classList.remove("panel-open");
      }

      // 패널이 닫힌 상태면 HUD는 항상 살아있게
      if(!body.classList.contains("panel-open") && hud){
        if(hud.style.display === "none") hud.style.display = "flex";
        hud.style.visibility = "visible";
        hud.style.pointerEvents = "auto";
      }
    }catch(_){}
  }

  // 가볍게 주기 체크
  setInterval(tick, 300);

  // 화면 터치/클릭 때도 한번씩
  window.addEventListener("pointerup", tick, {passive:true});
  window.addEventListener("visibilitychange", tick, {passive:true});
})();

})();

