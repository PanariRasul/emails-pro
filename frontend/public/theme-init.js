// Applies the saved theme before first paint (avoids a light/dark flash). Loaded synchronously from index.html.
(function () {
  try {
    var t = localStorage.getItem('ep-theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) { /* storage unavailable */ }
})();
