/**
 * SkyGuard WebRTC Stream Controller
 * Connects directly to go2rtc edge relay via backend WebRTC proxy
 * Enforces low-latency H.264 streaming and 16:9 anamorphic display
 */

class SkyStreamer {
  constructor(cardId, streamName, videoId, loaderId) {
    this.cardId = cardId;
    this.streamName = streamName;
    this.video = document.getElementById(videoId);
    this.loader = document.getElementById(loaderId);
    this.pc = null;
    this.reconnectTimer = null;
    this.isClosed = false;
    this.retryCount = 0;
  }

  async connect() {
    if (this.isClosed) return;
    this.cleanupPeerConnection();

    if (this.loader) {
      this.loader.style.display = 'flex';
      this.loader.querySelector('span')?.setText?.('Negotiating WebRTC...') || 
        (this.loader.querySelector('span').textContent = 'Negotiating WebRTC...');
    }

    try {
      this.pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });

      // Receive only video & audio
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      this.pc.addTransceiver('audio', { direction: 'recvonly' });

      this.pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          this.video.srcObject = event.streams[0];
          this.video.play().catch(e => {
            console.warn(`Autoplay blocked on stream ${this.streamName}:`, e);
          });
          if (this.loader) {
            this.loader.style.display = 'none';
          }
          this.retryCount = 0;
        }
      };

      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        if (state === 'connected') {
          if (this.loader) this.loader.style.display = 'none';
        } else if (state === 'failed' || state === 'disconnected') {
          console.warn(`Stream [${this.streamName}] connection state: ${state}. Reconnecting...`);
          this.scheduleReconnect(3000);
        }
      };

      // Create SDP Offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete or timeout
      await new Promise(resolve => {
        if (this.pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          const checkState = () => {
            if (this.pc.iceGatheringState === 'complete') {
              this.pc.removeEventListener('icegatheringstatechange', checkState);
              resolve();
            }
          };
          this.pc.addEventListener('icegatheringstatechange', checkState);
          setTimeout(resolve, 1500); // 1.5s max gather time
        }
      });

      // Send SDP Offer to SkyGuard WebRTC Proxy
      const response = await fetch(`/api/webrtc?src=${encodeURIComponent(this.streamName)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain'
        },
        body: this.pc.localDescription.sdp
      });

      if (!response.ok) {
        throw new Error(`Proxy error HTTP ${response.status}`);
      }

      const answerSdp = await response.text();
      if (!answerSdp || answerSdp.trim().length === 0) {
        throw new Error('Empty SDP answer received from relay');
      }

      await this.pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp
      });

    } catch (err) {
      console.error(`WebRTC streaming error for ${this.streamName}:`, err);
      if (this.loader) {
        this.loader.style.display = 'flex';
        const span = this.loader.querySelector('span');
        if (span) {
          span.textContent = `Retrying (${err.message.substring(0, 28)})...`;
        }
      }
      this.retryCount++;
      const backoff = Math.min(2000 * Math.pow(1.5, this.retryCount), 15000);
      this.scheduleReconnect(backoff);
    }
  }

  scheduleReconnect(delayMs) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.isClosed) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delayMs);
  }

  cleanupPeerConnection() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {}
      this.pc = null;
    }
  }

  close() {
    this.isClosed = true;
    this.cleanupPeerConnection();
    if (this.video) {
      this.video.srcObject = null;
    }
  }
}

// Global registry of camera streamers
window.skyStreamers = {};
