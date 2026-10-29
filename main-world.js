// Běží přímo ve stránce YouTube (MAIN world), protože jen odsud jde přečíst data přehrávače.
// Content script se zeptá na storyboard aktuálního videa a dostane ho zpátky přes postMessage.
(() => {
  function playerResponse() {
    const player = document.getElementById('movie_player');
    try {
      if (player && typeof player.getPlayerResponse === 'function') {
        const pr = player.getPlayerResponse();
        if (pr) return pr;
      }
    } catch {}
    return window.ytInitialPlayerResponse || null;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__fobi !== 'get-storyboard') return;
    const pr = playerResponse();
    const details = pr?.videoDetails;
    window.postMessage(
      {
        __fobi: 'storyboard',
        want: e.data.videoId,
        videoId: details?.videoId || null,
        lengthSeconds: Number(details?.lengthSeconds) || 0,
        isLive: !!details?.isLiveContent && !!pr?.playabilityStatus?.liveStreamability,
        spec: pr?.storyboards?.playerStoryboardSpecRenderer?.spec || null,
      },
      '*',
    );
  });
})();
