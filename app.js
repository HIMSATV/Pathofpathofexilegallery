// app.js (v2 Step3) - App owns boot + resize + loop
(function(){
  if(window.__APP_V2_BOOTED__) return;
  window.__APP_V2_BOOTED__ = true;

  function safe(fn){ try{ fn && fn(); }catch(e){ console && console.error && console.error(e); } }

  function getHudHeight(){
    const ui = document.getElementById("ui");
    if(!ui) return 0;
    const r = ui.getBoundingClientRect();
    return Math.max(0, r.height|0);
  }

  function doResize(){
    const canvas = document.getElementById("game");
    if(window.Game && Game.bindCanvas) safe(()=>Game.bindCanvas(canvas));

    const uiH = getHudHeight();
    const w = window.innerWidth;
    const h = Math.max(1, window.innerHeight - uiH);

    if(canvas){
      canvas.width = w;
      canvas.height = h;
    }
    safe(()=>window.Game && Game.resize && Game.resize(w, h, uiH));
  }

  function boot(){
    doResize();
    safe(()=>window.Game && Game.init && Game.init());

    window.addEventListener("resize", ()=>{ doResize(); }, {passive:true});
    window.addEventListener("orientationchange", ()=>{ setTimeout(doResize, 50); }, {passive:true});

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
