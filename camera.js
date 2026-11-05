/* Independent camera service. capture() returns { blob, width, height } for future consumers. */
class BookCamera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.generation = 0;
    this.cancelReady = null;
    video.muted = true;
    video.playsInline = true;
  }

  async start() {
    this.stop();
    const generation = this.generation;
    if (!window.isSecureContext) throw new Error('请通过 HTTPS 打开页面。电脑 localhost 只适用于电脑自身；手机访问电脑的 HTTP 局域网地址无法开启相机。');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持摄像头访问，请使用新版 Safari，并通过 HTTPS 打开页面。');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        throw new DOMException('已取消开启相机', 'AbortError');
      }
      this.stream = stream;
      this.video.srcObject = stream;
      await this.video.play();
      if (generation !== this.generation) throw new DOMException('已取消开启相机', 'AbortError');
      await this.waitForFrame();
      if (generation !== this.generation) throw new DOMException('已取消开启相机', 'AbortError');
      return this.dimensions;
    } catch (error) {
      if (generation === this.generation) this.stop();
      throw error;
    }
  }

  waitForFrame() {
    if (this.video.readyState >= 2 && this.video.videoWidth && this.video.videoHeight) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.video.removeEventListener('loadeddata', check);
        this.video.removeEventListener('resize', check);
        this.cancelReady = null;
      };
      const check = () => {
        if (this.video.readyState >= 2 && this.video.videoWidth && this.video.videoHeight) { cleanup(); resolve(); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('相机画面加载超时，请停止相机后重试。')); }, 15000);
      this.cancelReady = () => { cleanup(); reject(new DOMException('已停止相机', 'AbortError')); };
      this.video.addEventListener('loadeddata', check);
      this.video.addEventListener('resize', check);
      check();
    });
  }

  get dimensions() { return { width: this.video.videoWidth, height: this.video.videoHeight }; }

  async capture() {
    const generation = this.generation;
    const { width, height } = this.dimensions;
    if (!this.stream?.getVideoTracks().some(track => track.readyState === 'live') || this.video.readyState < 2 || !width || !height) {
      throw new Error('相机画面尚未就绪，请重新开启相机后拍摄。');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建照片，请重试。');
    // Use the full intrinsic video frame; never use CSS dimensions or crop coordinates.
    context.drawImage(this.video, 0, 0, width, height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (generation !== this.generation) throw new DOMException('已取消拍摄', 'AbortError');
    if (!blob) throw new Error('照片生成失败，请重试。');
    return { blob, width, height };
  }

  stop() {
    this.generation++;
    this.cancelReady?.();
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.video.pause();
    this.video.srcObject = null;
  }
}
window.BookCamera = BookCamera;
