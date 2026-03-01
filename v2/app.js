// app.js (v2)
// 최소 부트: game.js가 만든 resize/loop를 안전하게 한 번 실행
(function(){
  if(window.__APP_V2_BOOT__) return;
  window.__APP_V2_BOOT__ = true;

  function safeKick(){
    try{
      if(typeof window.resize === "function") window.resize();
      // iOS에서 최초 1프레임 늦게 레이아웃 잡히는 경우가 있어 한번 더
      setTimeout(()=>{ try{ if(typeof window.resize==="function") window.resize(); }catch(_e){} }, 0);
    }catch(e){
      console.error("app.js safeKick error", e);
    }
  }

  if(document.readyState === "complete") safeKick();
  else window.addEventListener("load", safeKick);
})();
