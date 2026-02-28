/* extracted UI scripts from original head */

/* Toggle overlayActive class automatically */
document.addEventListener("click", function() {
  const overlays = document.querySelectorAll(
    "#craftOverlay, #bagOverlay, #equipOverlay, #statOverlay, #statsOverlay"
  );
  let active = false;
  overlays.forEach(o => {
    if (window.getComputedStyle(o).display !== "none") {
      active = true;
    }
  });
  if (active) {
    document.body.classList.add("overlayActive");
  } else {
    document.body.classList.remove("overlayActive");
  }
});

// ===== Disable toasts (keep UI clean) =====
window.showToast = window.showToast || function(){};
window.toast = window.toast || function(){};


// ===== Loot Button binding (emoji) =====
(function(){
  const b = document.getElementById('lootBtn');
  if(!b) return;
  const stop = (e)=>{ if(!e) return; e.preventDefault(); e.stopPropagation(); };
  const doLoot = ()=>{
    try{
      if(typeof window.lootNearbyItems === 'function') window.lootNearbyItems();
      else if(typeof lootNearbyItems === 'function') lootNearbyItems();
      else if(typeof window.lootItemsNearby === 'function') window.lootItemsNearby();
    }catch(err){
      console.error('lootBtn error', err);
    }
  };
  b.addEventListener('touchstart', (e)=>{ stop(e); doLoot(); }, {passive:false});
  b.addEventListener('mousedown', (e)=>{ stop(e); doLoot(); });
  b.addEventListener('click', (e)=>{ stop(e); doLoot(); });
})();
