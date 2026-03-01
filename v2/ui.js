// ui.js (v2) - MOBILE UI REPLACEMENT (Step: UI swap)
// Goals:
// - Mobile-first HUD (joystick + attack + loot + bag/equip + miniBag)
// - Fullscreen overlays (equip/bag/craft) with required IDs
// - Provide window.UI bridge + overlay stack helpers
// - Do NOT assume anything about game.js internals besides required element IDs
(function(){
  if (window.__UI_V2_SWAP__) return;
  window.__UI_V2_SWAP__ = true;

  const root = document.getElementById("ui-root");
  if (!root) return;

  // Prevent accidental double-injection
  if (document.getElementById("ui")) return;

  // Safe-area CSS vars (iOS)
  function setSafeAreaVars(){
    const st = getComputedStyle(document.documentElement);
    // fallbacks handled in CSS; we just expose vars so CSS can use them
    document.documentElement.style.setProperty("--safeTop", "env(safe-area-inset-top)");
    document.documentElement.style.setProperty("--safeBottom", "env(safe-area-inset-bottom)");
  }
  setSafeAreaVars();

  // Helpers
  const h = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content;
  };

  // Inject DOM (mobile-first)
  root.appendChild(h(`
    <!-- HUD -->
    <div id="ui">
      <div id="movePad" aria-label="move pad"><div id="stick"></div></div>

      <div id="hudBtns">
        <button id="btnEquip" type="button" aria-label="equip">E</button>
        <button id="btnBag" type="button" aria-label="bag">B</button>
        <button id="miniBagBtn" type="button" aria-label="mini bag">🎒</button>

        <button id="lootBtn" type="button" aria-label="loot">L</button>

        <button id="attackBtn" type="button" aria-label="attack">
          <canvas id="attackIcon" width="64" height="64"></canvas>
        </button>
      </div>

      <div id="specText"></div>
    </div>

    <!-- overlays -->
    <div id="equipOverlay" style="display:none;">
      <div class="panel">
        <div class="panelHeader">
          <button id="btnEquipClose" type="button" aria-label="close">✕</button>
          <div class="panelTitle">장비</div>
        </div>
        <div class="panelBody">
          <div id="equipSlots"></div>
          <div id="equipInfo"></div>
        </div>
        <div class="panelFooter">
          <button id="btnEquipToBag" type="button">가방</button>
          <button id="btnEquipCraft" type="button">제작</button>
          <button id="btnEquipUnequip" type="button">해제</button>
        </div>
      </div>
    </div>

    <div id="bagOverlay" style="display:none;">
      <div class="panel">
        <div class="panelHeader">
          <button id="btnBagClose" type="button" aria-label="close">✕</button>
          <div class="panelTitle">가방</div>
        </div>
        <div class="panelBody">
          <div id="bagGrid"></div>
          <div id="bagInfo"></div>
        </div>
        <div class="panelFooter">
          <button id="btnBagToEquip" type="button">장비</button>
          <button id="btnBagCraft" type="button">제작</button>
          <button id="btnBagEquip" type="button">장착</button>
        </div>
      </div>
    </div>

    <div id="craftOverlay" style="display:none;">
      <div class="panel">
        <div class="panelHeader">
          <button id="btnCraftClose" type="button" aria-label="close">✕</button>
          <div class="panelTitle">제작</div>
        </div>

        <div class="panelBody">
          <div class="craftTop">
            <canvas id="craftItemIcon" width="96" height="96"></canvas>
            <div id="craftItemText"></div>
          </div>

          <div id="metaCraftBox"></div>

          <div id="craftOrbGrid">
            <button id="orbTransmute" class="orbBtn" type="button">변화</button>
            <button id="orbAlter" class="orbBtn" type="button">수정</button>
            <button id="orbAug" class="orbBtn" type="button">증강</button>
            <button id="orbRegal" class="orbBtn" type="button">제왕</button>
            <button id="orbAlchemy" class="orbBtn" type="button">연금</button>
            <button id="orbScour" class="orbBtn" type="button">초기화</button>
            <button id="orbAnnul" class="orbBtn" type="button">제거</button>
            <button id="orbExalt" class="orbBtn" type="button">승격</button>
            <button id="orbDivine" class="orbBtn" type="button">신성</button>
            <button id="orbCorrupt" class="orbBtn" type="button">타락</button>
          </div>

          <div id="orbDesc"></div>
          <div id="orbCounts"></div>
        </div>

        <div class="panelFooter">
          <button id="btnCraftToEquip" type="button">장비</button>
          <button id="btnCraftToBag" type="button">가방</button>
          <button id="btnCraftApply" type="button">적용</button>
          <button id="btnLockPrefix" type="button">접두 고정</button>
          <button id="btnLockSuffix" type="button">접미 고정</button>
          <button id="btnRemoveMeta" type="button">메타 제거</button>
          <button id="chaosBtn" type="button">카오스</button>
        </div>
      </div>
    </div>

    <!-- optional overlays used by some builds -->
    <div id="lootOverlay" style="display:none;"><div id="lootCards"></div></div>
    <div id="lootToast" style="display:none;"></div>

    <!-- fatal error (game.js may use it) -->
    <div id="fatalErrorOverlay" style="display:none;"></div>
  `));

  // ===== UI Bridge =====
  window.UI = window.UI || (function(){
    const api = {
      el(id){ return document.getElementById(id); },
      show(id){ const e = api.el(id); if(e) e.style.display = "flex"; },
      hide(id){ const e = api.el(id); if(e) e.style.display = "none"; },
      toggle(id,on){ (on?api.show:api.hide)(id); },
      text(id,t){ const e=api.el(id); if(e) e.textContent = (t??""); },
      html(id,h){ const e=api.el(id); if(e) e.innerHTML = (h??""); },
      ctx(id){ const c=api.el(id); return (c&&c.getContext)?c.getContext("2d"):null; },
      on(id,evt,fn,opt){ const e=api.el(id); if(!e) return false; e.addEventListener(evt,fn,opt); return true; }
    };
    return api;
  })();

  // ===== HUD Safety =====
  function ensureHUDVisible(){
    // Some game builds hide HUD when opening panels. Always restore after closing.
    const hud = document.getElementById("ui");
    if(hud) hud.style.display = "flex";
    document.body.classList.remove("overlayActive");
  }

  // ===== Overlay Stack =====
  const stack = [];
  function setOverlayActive(on){
    document.body.classList.toggle("overlayActive", !!on);
  }
  function pushOverlay(id){
    const el = document.getElementById(id);
    if(!el) return false;
    if(!stack.includes(id)) stack.push(id);
    el.style.display = "flex";
    setOverlayActive(true);
    return true;
  }
  function popOverlay(id){
    const el = document.getElementById(id);
    if(el) el.style.display = "none";
    const i = stack.lastIndexOf(id);
    if(i>=0) stack.splice(i,1);
    setOverlayActive(stack.length>0);
    if(stack.length===0) ensureHUDVisible();
  }

  // Expose minimal overlay api (optional use by game.js)
  window.UIOverlay = window.UIOverlay || { push: pushOverlay, pop: popOverlay, active: ()=>stack.length>0 };

  // Close buttons: 항상 안전하게 (overlay + game panels 둘 다 닫기)
function closeAllUI(){
  // 1) our overlays off
  try{
    stack.length = 0;
    setOverlayActive(false);
    // 확실히 숨김
    ["equipOverlay","bagOverlay","craftOverlay"].forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.style.display = "none";
    });
    ensureHUDVisible();
  }catch(_){}
  // 2) game side panels off (legacy)
  try{
    if(window.Game && typeof window.Game.closePanels === "function"){
      window.Game.closePanels();
    }
  }catch(_){}
  // 3) 마지막 안전장치
  try{ ensureHUDVisible(); }catch(_){}
}

UI.on("btnEquipClose","click", closeAllUI);
UI.on("btnBagClose","click",   closeAllUI);
UI.on("btnCraftClose","click", closeAllUI);

  // Make overlay backdrop click close (panel 제외)
  ["equipOverlay","bagOverlay","craftOverlay"].forEach(id=>{
    const ov = document.getElementById(id);
    if(!ov) return;
    ov.addEventListener("click", (e)=>{
      const panel = ov.querySelector(".panel");
      if(panel && panel.contains(e.target)) return;
      popOverlay(id); ensureHUDVisible();
    });
  });

  // Ensure buttons have type=button
  try{ root.querySelectorAll("button").forEach(b=>{ if(!b.getAttribute("type")) b.setAttribute("type","button"); }); }catch(_){}
})();
