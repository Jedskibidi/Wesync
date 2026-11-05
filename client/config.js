/**
 * @file config.js
 * @description Sets window.WESYNC_API_URL, the address of the Wesync server.
 * On localhost or a local network address it stays empty (same origin, since
 * the server also serves the client when SERVE_CLIENT=true). Otherwise it
 * points to the production server on Render.
 * @location client\config.js
 */

(function () {
  var host = location.hostname;
  var isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host);
  window.WESYNC_API_URL = isLocal ? "" : "https://wesync-shmf.onrender.com";
})();
