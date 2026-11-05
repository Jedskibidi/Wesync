/**
 * @file visualizer.js
 * @description Audio visualizer: animated bars driven by the Web Audio API
 * AnalyserNode. Draws on a <canvas> added to the player card (under "Now
 * playing"). Bars move while the song plays and stop when it is paused.
 * Nothing is sent to the server, so room sync is not affected.
 * Depends on this name from app.js (keep it if app.js changes): audio
 * (the <audio> element).
 * @location client\visualizer.js
 */

(() => {
  const player = document.getElementById("player");
  if (!player || typeof audio === "undefined") return;

  const BAR_COUNT = 24;
  const BIN_STEP = 2;
  const BAR_W = 8;
  const BAR_GAP = 2;
  const SEG_H = 4;
  const SEG_GAP = 1;
  const ROWS = 12;
  const WIDTH = BAR_COUNT * (BAR_W + BAR_GAP) - BAR_GAP;
  const HEIGHT = ROWS * (SEG_H + SEG_GAP) - SEG_GAP;

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

  const css = getComputedStyle(document.documentElement);
  const COLOR_BG = css.getPropertyValue("--ink").trim() || "#5a2d0c";
  const COLOR_LOW = css.getPropertyValue("--honey").trim() || "#f7b731";
  const COLOR_HIGH = css.getPropertyValue("--honey-light").trim() || "#ffd966";

  function draw(levels) {
    g.fillStyle = COLOR_BG;
    g.fillRect(0, 0, WIDTH, HEIGHT);

    for (let i = 0; i < BAR_COUNT; i++) {
      const blocks = Math.max(1, Math.round(levels[i] * ROWS));
      const x = i * (BAR_W + BAR_GAP);
      for (let b = 0; b < blocks; b++) {
        const y = HEIGHT - (b + 1) * SEG_H - b * SEG_GAP;
        g.fillStyle = b >= ROWS * 0.7 ? COLOR_HIGH : COLOR_LOW;
        g.fillRect(x, y, BAR_W, SEG_H);
      }
    }
  }

  const IDLE = new Array(BAR_COUNT).fill(0);

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
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.8;
      data = new Uint8Array(analyser.frequencyBinCount);

      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);
    } catch (err) {
      console.warn("Visualizer disabled:", err);
      failed = true;
      ctx = null;
      analyser = null;
    }
  }

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
    if (frameId === null) frameId = requestAnimationFrame(frame);
  }

  function stop() {
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    draw(IDLE);
  }

  audio.addEventListener("playing", start);

  ["pause", "ended", "emptied"].forEach((name) => {
    audio.addEventListener(name, stop);
  });

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
