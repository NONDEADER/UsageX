(function() {
  if (document.getElementById('ux-fetch-hook')) return;
  const script = document.createElement('script');
  const browserApi = typeof browser !== 'undefined' ? browser : chrome;
  script.src = browserApi.runtime.getURL('inject.js');
  script.id = 'ux-fetch-hook';
  (document.head || document.documentElement).appendChild(script);
})();
