// app.js (v2 Step2) - App owns boot + loop
(function(){
  if(window.__APP_V2_BOOTED__) return;
  window.__APP_V2_BOOTED__ = true;

  function safe(fn){ try{ fn && fn(); }catch(e){ console && console.error && console.error(e); } }

  function boot(){
    // init once
    safe(()=>window.Game && window.Game.init && window.Game.init());
    // initial resize
    safe(()=>window.Game && window.Game.resize && window.Game.resize());

    function frame(){
      safe(()=>window.Game && window.Game.loop && window.Game.loop());
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  window.addEventListener("load", boot);
  window.addEventListener("resize", ()=> safe(()=>window.Game && window.Game.resize && window.Game.resize()));
})();
