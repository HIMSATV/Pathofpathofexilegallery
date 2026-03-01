window.addEventListener("load", function () {

  if (typeof resize === "function") {
    resize();
  }

  if (typeof init === "function") {
    init();
  }

  if (typeof loop === "function") {
    loop();
  }

});
   
