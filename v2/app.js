// app.js (v2) - SAFE BOOT
// game.js가 자체적으로 init/loop를 돌리는 구조를 존중하고, resize만 보조한다.
window.addEventListener("load", function () {
  try { if (typeof resize === "function") resize(); } catch(_) {}
});
