// Audio visualizer: animated bars driven by the Web Audio API AnalyserNode.
//
// Draws on a <canvas> that it adds to the player card (under "Now playing").
// Bars move while the song plays and the animation stops when it is paused.
// Nothing here is sent to the server, so there is no effect on room sync.
//
// It uses this from app.js:
//   audio  (the <audio> element)
// Keep that name if app.js is ever changed.

(() => {
  const player = document.getElementById("player");
  if (!player || typeof audio === "undefined") return;

  // ---------- Settings ----------

  const BAR_COUNT = 24;
  const BIN_STEP = 2; // each bar averages this many frequency bins
  const BAR_W = 8; // canvas pixels (the canvas is scaled up, pixelated)
  const BAR_GAP = 2;
  const SEG_H = 4; // height of one block in a bar
  const SEG_GAP = 1;
  const ROWS = 12; // blocks in a full bar
  const WIDTH = BAR_COUNT * (BAR_W + BAR_GAP) - BAR_GAP;
  const HEIGHT = ROWS * (SEG_H + SEG_GAP) - SEG_GAP;

  // ---------- Build the canvas ----------

  const style = document.createElement("style");
  style.textContent = `
    #visualizer {
      display: block; width: 100%; height: auto;
      border: 3px solid var(--ink);
      background: var(--ink);
      image-rendering: pixelated;
    }
  `;
  document.head.appendChild(style);

  const canvas = document.createElement("canvas");
  canvas.id = "visualizer";
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Music visualizer");

  const nowPlaying = player.querySelector(".now-playing");
  if (nowPlaying) nowPlaying.insertAdjacentElement("afterend", canvas);
  else player.appendChild(canvas);

  const g = canvas.getContext("2d");

  // Colors come from the theme, so they follow style.css
  const css = getComputedStyle(document.documentElement);
  const COLOR_BG = css.getPropertyValue("--ink").trim() || "#5a2d0c";
  const COLOR_LOW = css.getPropertyValue("--honey").trim() || "#f7b731";
  const COLOR_HIGH = css.getPropertyValue("--honey-light").trim() || "#ffd966";

  // ---------- Drawing ----------

  // level is 0..1 for each bar. The idle state is one small block per bar.
  function draw(levels) {
    g.fillStyle = COLOR_BG;
    g.fillRect(0, 0, WIDTH, HEIGHT);

    for (let i = 0; i < BAR_COUNT; i++) {
      const blocks = Math.max(1, Math.round(levels[i] * ROWS));
      const x = i * (BAR_W + BAR_GAP);
      for (let b = 0; b < blocks; b++) {
        const y = HEIGHT - (b + 1) * SEG_H - b * SEG_GAP;
        // The top third of a full bar is lighter
        g.fillStyle = b >= ROWS * 0.7 ? COLOR_HIGH : COLOR_LOW;
        g.fillRect(x, y, BAR_W, SEG_H);
      }
    }
  }

  const IDLE = new Array(BAR_COUNT).fill(0);

  // ---------- Web Audio graph ----------
  // audio -> source -> analyser -> speakers
  // createMediaElementSource() may only be called ONCE per <audio>, so the
  // graph is built the first time sound really plays, and then kept.

  let ctx = null;
  let analyser = null;
  let data = null;
  let failed = false;
  let frameId = null;

  function setupGraph() {
    if (ctx || failed) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error("Web Audio is not supported");

      ctx = new AudioCtx();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 128; // 64 frequency bins
      analyser.smoothingTimeConstant = 0.8; // smooth, less jumpy bars
      data = new Uint8Array(analyser.frequencyBinCount);

      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination); // keep the sound coming out
    } catch (err) {
      // If anything fails, the player keeps working without the visualizer
      console.warn("Visualizer disabled:", err);
      failed = true;
      ctx = null;
      analyser = null;
    }
  }

  // ---------- Animation ----------

  function frame() {
    analyser.getByteFrequencyData(data);

    const levels = new Array(BAR_COUNT);
    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0;
      for (let j = 0; j < BIN_STEP; j++) sum += data[i * BIN_STEP + j];
      levels[i] = sum / BIN_STEP / 255;
    }
    draw(levels);

    frameId = requestAnimationFrame(frame);
  }

  function start() {
    setupGraph();
    if (!analyser) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    if (frameId === null) frameId = requestAnimationFrame(frame); // one loop only
  }

  function stop() {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    draw(IDLE);
  }

  // ---------- Wiring ----------

  // "playing" means sound is really coming out (not just that play() was
  // called), so this also covers a song resuming after buffering.
  audio.addEventListener("playing", start);

  // pause also fires when a song ends. "emptied" fires when the song is cleared.
  ["pause", "ended", "emptied"].forEach((name) => {
    audio.addEventListener(name, stop);
  });

  // Don't burn CPU drawing a tab nobody can see. Resume when it comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    } else if (analyser && !audio.paused) {
      start();
    }
  });

  draw(IDLE);
})();