// app.v2.js - FINAL stable boot (single source of truth)
// Policy:
// - app owns RAF loop
// - app owns canvas sizing (sets both canvas.width/height and CSS style width/height)
// - game exposes Game.bindCanvas / Game.resize / Game.init / Game.loop
(function(){
  if(window.__APP_V2_FINAL__) return;
  window.__APP_V2_FINAL__ = true;

  function safe(fn){ try{ fn && fn(); }catch(e){ console && console.error && console.error(e); } }

  function getHudHeight(){
    const ui = document.getElementById("ui");
    if(!ui) return 0;
    const r = ui.getBoundingClientRect();
    return Math.max(0, r.height|0);
  }

  function doResize(){
    const canvas = document.getElementById("game");
    if(window.Game && window.Game.bindCanvas) safe(()=>window.Game.bindCanvas(canvas));

    const uiH = getHudHeight();
    const w = window.innerWidth|0;
    const h = Math.max(1, (window.innerHeight|0) - uiH);

    if(canvas){
      canvas.width = w;
      canvas.height = h;
      // Prevent CSS from stretching to 100vh and causing "black screen" illusions.
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
    }
    safe(()=>window.Game && window.Game.resize && window.Game.resize(w, h, uiH));
  }

  function boot(){
    doResize();
    safe(()=>window.Game && window.Game.init && window.Game.init());

    window.addEventListener("resize", ()=>{ doResize(); }, {passive:true});
    window.addEventListener("orientationchange", ()=>{ setTimeout(doResize, 60); }, {passive:true});

    function frame(){
      safe(()=>window.Game && window.Game.loop && window.Game.loop());
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", boot, {once:true});
  }else{
    boot();
  }
})();
