// v2/app.js (fixed)
// 역할: 부팅 보조. game.js가 자체적으로 init/loop를 돌리므로 여기서는 resize만 해준다.

(function(){
  function safeResize(){
    try{
      if (typeof resize === "function") resize();
    }catch(e){}
  }

  window.addEventListener("load", function(){
    safeResize();
    // iOS에서 로드 직후 뷰포트 값이 늦게 잡히는 경우가 있어 한 번 더
    setTimeout(safeResize, 50);
    setTimeout(safeResize, 250);
  });

  window.addEventListener("resize", function(){
    requestAnimationFrame(safeResize);
  });

  window.addEventListener("orientationchange", function(){
    setTimeout(safeResize, 50);
    setTimeout(safeResize, 250);
  });
})();
