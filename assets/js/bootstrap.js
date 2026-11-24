// Fuente insertada en el HTML por tools/build.mjs: no requiere otra descarga.
(() => {
  const entry = document.getElementById("directoryModule").href;
  const panel = document.getElementById("loadError");
  const grid = document.getElementById("providerGrid");
  const retry = panel.querySelector("button");
  let running = false;
  let generation = 0;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run() {
    if (running) return;
    running = true;
    panel.hidden = true;
    grid.setAttribute("aria-busy", "true");
    document.getElementById("resultsCount").textContent = "Cargando…";
    let app;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = new URL(entry);
      // Solo un fallo crea otra URL; las visitas normales aprovechan su caché.
      if (generation) url.searchParams.set("recovery", String(generation));
      generation++;
      let timer;
      try {
        app = await Promise.race([
          import(url.href),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("El programa no terminó de descargar")), 8000); }),
        ]);
        break;
      } catch (error) {
        lastError = error;
        console.error(error);
        document.getElementById("resultsCount").textContent = "Reconectando…";
        if (attempt < 2) await wait(attempt === 0 ? 500 : 1500);
      } finally { clearTimeout(timer); }
    }
    if (app) {
      retry.onclick = null;
      try {
        app.start();
        // La instalación es opcional; tampoco demora DOMContentLoaded.
        const install = document.getElementById("directoryModule").dataset.installSrc;
        if (install) void import(new URL(install, location.href).href).catch(console.error);
        running = false;
        return;
      } catch (error) {
        lastError = error;
        // No repetir la inicialización si ya llegó a registrar eventos.
        retry.onclick = () => location.reload();
      }
    } else {
      retry.onclick = run;
    }
    console.error("No se pudo iniciar Plaza Vitarte", lastError);
    grid.replaceChildren();
    grid.setAttribute("aria-busy", "false");
    document.getElementById("resultsCount").textContent = "No se pudo abrir el directorio";
    panel.querySelector("p").textContent = "No pudimos completar la conexión. Puedes intentarlo de nuevo.";
    panel.hidden = false;
    running = false;
  }
  void run();
})();
