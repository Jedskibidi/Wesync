// Where the Wesync server lives.
// Local development (localhost or a local network address): same origin, because
// the server also serves this client when SERVE_CLIENT=true.
// Production: the address of the Render service. Replace the placeholder below.
(function () {
  var host = location.hostname;
  var isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^192\.168\./.test(host) ||
    /^10\./.test(host);
  window.WESYNC_API_URL = isLocal ? "" : "https://YOUR-WESYNC-SERVER.onrender.com";
})();
