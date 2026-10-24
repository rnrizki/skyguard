/**
 * SkyGuard Live Monitoring Hub - Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
  const cameraGrid = document.getElementById('camera-grid');
  const cards = document.querySelectorAll('.camera-card');
  const gridButtons = document.querySelectorAll('.grid-btn');
  const reconnectAllBtn = document.getElementById('btn-reconnect-all');

  // Initialize streamers for each camera card
  cards.forEach(card => {
    const id = card.id.replace('card-', '');
    const streamName = card.dataset.stream;
    const videoId = `video-${id}`;
    const loaderId = `loader-${id}`;

    if (streamName && document.getElementById(videoId)) {
      const streamer = new SkyStreamer(card.id, streamName, videoId, loaderId);
      window.skyStreamers[id] = streamer;
      streamer.connect();
    }
  });

  // Start live timestamp clock overlay for cameras
  setInterval(updateLiveClocks, 1000);
  updateLiveClocks();

  // Grid layout selector handlers (3x3, 2x2, 1x1)
  gridButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetGrid = btn.dataset.grid;

      gridButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (cameraGrid) {
        cameraGrid.classList.remove('grid-3x3', 'grid-2x2', 'grid-1x1');
        cameraGrid.classList.add(targetGrid);

        // Visibility management based on layout
        cards.forEach((card, index) => {
          if (targetGrid === 'grid-1x1') {
            card.style.display = index === 0 ? 'flex' : 'none';
          } else if (targetGrid === 'grid-2x2') {
            card.style.display = index < 4 ? 'flex' : 'none';
          } else {
            card.style.display = 'flex';
          }
        });
      }
    });
  });

  // Reconnect all button handler
  if (reconnectAllBtn) {
    reconnectAllBtn.addEventListener('click', () => {
      reconnectAllBtn.disabled = true;
      reconnectAllBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M12 6v6l4 2"></path>
        </svg> Reconnecting...
      `;

      Object.values(window.skyStreamers).forEach(streamer => {
        streamer.connect();
      });

      setTimeout(() => {
        reconnectAllBtn.disabled = false;
        reconnectAllBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"></polyline>
            <polyline points="1 20 1 14 7 14"></polyline>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg> Reconnect All
        `;
      }, 1500);
    });
  }

  // Double click on camera card for fullscreen (PC / Mac)
  cards.forEach(card => {
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      toggleCamFullscreen(card.id);
    });
  });
});

// Mobile tap handler for live camera cards
let lastTapTime = 0;
window.handleLiveCardTap = function(e, cardId) {
  const currentTime = new Date().getTime();
  const diff = currentTime - lastTapTime;
  // If double tap within 400ms or touched on mobile
  if (diff < 400 && diff > 0) {
    toggleCamFullscreen(cardId);
    e.preventDefault();
  } else if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    // Single tap on mobile directly goes fullscreen
    toggleCamFullscreen(cardId);
  }
  lastTapTime = currentTime;
};

// Update live camera clocks (Asia/Jakarta WIB)
function updateLiveClocks() {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }) + ' WIB';

  document.querySelectorAll('.timestamp-display').forEach(el => {
    el.textContent = timeStr;
  });
}

// Fullscreen toggle for individual camera cards (Desktop + Mobile Safari/Android)
window.toggleCamFullscreen = function(cardId) {
  const card = typeof cardId === 'string' ? document.getElementById(cardId) : cardId;
  if (!card) return;

  const video = card.querySelector('video');
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;

  if (!isFs) {
    if (card.requestFullscreen) {
      card.requestFullscreen().catch(() => {
        if (video && video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      });
    } else if (card.webkitRequestFullscreen) {
      card.webkitRequestFullscreen();
    } else if (video && video.webkitEnterFullscreen) {
      // iOS Safari native fullscreen
      video.webkitEnterFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
};
