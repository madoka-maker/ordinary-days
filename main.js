// ===== 調整用パラメータ =====
// 数値を変えるだけで見た目・操作感を調整できるように、一箇所にまとめている。
const CONFIG = {
  screen: {
    internalWidth: 250,
    internalHeight: 542,
  },
  camera: {
    height: 1000,
    fieldOfView: 100,
    horizonRatio: 0.40, // 画面上から何割の位置を地平線にするか（道路を主役にするため低め）
  },
  road: {
    width: 2000,
    segmentLength: 200,
    rumbleLength: 3,     // 縞模様1色分のセグメント数
    trackSegments: 500,  // ループさせる全長（セグメント数）
    drawDistance: 220,   // 手前から何セグメント先まで描くか
    grassFactor: 3.2,    // 道路幅に対する草地の広さ
  },
  speed: {
    forward: 2600,       // 1秒あたりに進む距離（world units）
  },
  steer: {
    moveSpeed: 1.1,      // 1秒あたりの左右移動量（-1〜1の範囲に対して）
    maxOffset: 0.82,     // 道路からはみ出さないための左右移動の限界
    tiltMax: 0.10,        // ハンドルが傾く最大角度（ラジアン）
    tiltEase: 9,          // ハンドルの傾きが目標値に近づく速さ
  },
  audio: {
    volume: 0.32,
    fadeInSeconds: 1.6,
  },
};

// ===== Canvas セットアップ =====
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
canvas.width = CONFIG.screen.internalWidth;
canvas.height = CONFIG.screen.internalHeight;
ctx.imageSmoothingEnabled = false;

const W = CONFIG.screen.internalWidth;
const H = CONFIG.screen.internalHeight;
const HORIZON_Y = H * CONFIG.camera.horizonRatio;
const CAMERA_DEPTH = 1 / Math.tan((CONFIG.camera.fieldOfView / 2) * Math.PI / 180);

// ===== 星空・山の下準備（毎フレーム再計算しないよう先に作っておく） =====
const stars = Array.from({ length: 45 }, () => ({
  x: Math.random() * W,
  y: Math.random() * HORIZON_Y * 0.9,
  r: Math.random() < 0.85 ? 1 : 1.6,
  a: 0.35 + Math.random() * 0.5,
}));

function buildMountainSilhouette() {
  const points = [];
  const segments = 14;
  let h = 0.18 + Math.random() * 0.1;
  for (let i = 0; i <= segments; i++) {
    h += (Math.random() - 0.5) * 0.09;
    h = Math.max(0.06, Math.min(0.32, h));
    points.push({ x: (W / segments) * i, y: HORIZON_Y * (1 - h) });
  }
  return points;
}
const mountainPoints = buildMountainSilhouette();

// ===== 道路セグメント =====
const segments = [];
for (let i = 0; i < CONFIG.road.trackSegments; i++) {
  const isRumbleOn = Math.floor(i / CONFIG.road.rumbleLength) % 2 === 0;
  segments.push({
    index: i,
    grassColor: i % 2 === 0 ? '#0d1f16' : '#0a1810',
    roadColor: isRumbleOn ? '#26262d' : '#212129',
    rumbleColor: isRumbleOn ? '#5a1717' : '#8f8f8f',
    laneOn: isRumbleOn,
  });
}

// ===== ゲーム状態 =====
const state = {
  position: 0,      // トラック上を進んだ距離
  playerOffset: 0,   // -1(左端)〜1(右端)
  handlebarTilt: 0,
  targetTilt: 0,
  keys: { left: false, right: false },
  started: false,
};

// ===== 入力 =====
window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') state.keys.left = true;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') state.keys.right = true;
  if (e.key.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') state.keys.left = false;
  if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') state.keys.right = false;
});

// ===== 環境音（鈴虫）=====
// 実際の録音ファイルが用意できたら、このクラスの中身を
// <audio src="assets/audio/crickets.mp3" loop> を使う実装に差し替えれば、
// start()/stop()/setVolume() のインターフェースはそのまま使い回せる。
class AmbientCrickets {
  constructor(volume) {
    this.targetVolume = volume;
    this.ctx = null;
    this.masterGain = null;
    this.running = false;
    this.timerId = null;
  }

  _ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0;
      this.masterGain.connect(this.ctx.destination);
    }
  }

  start() {
    this._ensureContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.running = true;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
    this.masterGain.gain.linearRampToValueAtTime(this.targetVolume, now + CONFIG.audio.fadeInSeconds);
    this._scheduleNext();
  }

  stop() {
    this.running = false;
    if (this.timerId) clearTimeout(this.timerId);
    if (this.masterGain) {
      const now = this.ctx.currentTime;
      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now);
      this.masterGain.gain.linearRampToValueAtTime(0, now + 0.8);
    }
  }

  setVolume(v) {
    this.targetVolume = v;
    if (this.masterGain) this.masterGain.gain.value = v;
  }

  _scheduleNext() {
    if (!this.running) return;
    this._playChirp();
    const longPause = Math.random() < 0.12;
    const delay = longPause ? 420 + Math.random() * 420 : 90 + Math.random() * 150;
    this.timerId = setTimeout(() => this._scheduleNext(), delay);
  }

  _playChirp() {
    const ctx = this.ctx;
    const pulseCount = 2 + Math.floor(Math.random() * 2);
    const baseFreq = 4000 + Math.random() * 700;
    for (let i = 0; i < pulseCount; i++) {
      const t = ctx.currentTime + i * 0.032;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = baseFreq + Math.random() * 100;
      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = baseFreq;
      bandpass.Q.value = 9;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.5, t + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      osc.connect(bandpass);
      bandpass.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.06);
    }
  }
}
const ambientCrickets = new AmbientCrickets(CONFIG.audio.volume);

// ===== START ボタン =====
const startOverlay = document.getElementById('start-overlay');
const startButton = document.getElementById('start-button');
startButton.addEventListener('click', () => {
  if (state.started) return;
  state.started = true;
  startOverlay.classList.add('hidden');
  ambientCrickets.start();
});

// ===== 疑似3D投影 =====
function projectPoint(worldX, z, cameraX) {
  const clampedZ = Math.max(z, 1);
  const scale = CAMERA_DEPTH / clampedZ;
  return {
    x: (W / 2) + scale * (worldX - cameraX) * (W / 2),
    y: HORIZON_Y + scale * CONFIG.camera.height * (H - HORIZON_Y),
    scale,
  };
}

// ===== 更新 =====
let lastTime = performance.now();
function update(dt) {
  state.position += CONFIG.speed.forward * dt;
  const trackLength = CONFIG.road.trackSegments * CONFIG.road.segmentLength;
  if (state.position >= trackLength) state.position -= trackLength;

  if (state.keys.left && !state.keys.right) {
    state.playerOffset -= CONFIG.steer.moveSpeed * dt;
    state.targetTilt = -CONFIG.steer.tiltMax;
  } else if (state.keys.right && !state.keys.left) {
    state.playerOffset += CONFIG.steer.moveSpeed * dt;
    state.targetTilt = CONFIG.steer.tiltMax;
  } else {
    state.targetTilt = 0;
  }
  state.playerOffset = Math.max(-CONFIG.steer.maxOffset, Math.min(CONFIG.steer.maxOffset, state.playerOffset));
  state.handlebarTilt += (state.targetTilt - state.handlebarTilt) * Math.min(1, CONFIG.steer.tiltEase * dt);
}

// ===== 描画 =====
function drawSky() {
  const grad = ctx.createLinearGradient(0, 0, 0, HORIZON_Y);
  grad.addColorStop(0, '#04050d');
  grad.addColorStop(1, '#1b2843');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, HORIZON_Y);

  // 月
  const moonX = W * 0.74;
  const moonY = HORIZON_Y * 0.28;
  const glow = ctx.createRadialGradient(moonX, moonY, 2, moonX, moonY, 26);
  glow.addColorStop(0, 'rgba(240,238,214,0.55)');
  glow.addColorStop(1, 'rgba(240,238,214,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(moonX, moonY, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f2f0d6';
  ctx.beginPath();
  ctx.arc(moonX, moonY, 9, 0, Math.PI * 2);
  ctx.fill();

  // 星
  for (const s of stars) {
    ctx.fillStyle = `rgba(232,230,216,${s.a})`;
    ctx.fillRect(s.x, s.y, s.r, s.r);
  }

  // 山のシルエット
  ctx.fillStyle = '#0a1220';
  ctx.beginPath();
  ctx.moveTo(0, HORIZON_Y);
  for (const p of mountainPoints) ctx.lineTo(p.x, p.y);
  ctx.lineTo(W, HORIZON_Y);
  ctx.closePath();
  ctx.fill();
}

function drawGround() {
  ctx.fillStyle = '#081a10';
  ctx.fillRect(0, HORIZON_Y, W, H - HORIZON_Y);
}

function drawRoad() {
  const trackLength = CONFIG.road.trackSegments * CONFIG.road.segmentLength;
  const baseIndex = Math.floor(state.position / CONFIG.road.segmentLength) % CONFIG.road.trackSegments;
  const zOffset = state.position % CONFIG.road.segmentLength;
  const cameraX = state.playerOffset * (CONFIG.road.width / 2) * 0.8;

  // 奥から手前へ描く（画家のアルゴリズム）
  for (let n = CONFIG.road.drawDistance - 1; n >= 0; n--) {
    const segment = segments[(baseIndex + n) % CONFIG.road.trackSegments];
    const z1 = n * CONFIG.road.segmentLength - zOffset;
    const z2 = z1 + CONFIG.road.segmentLength;
    if (z2 <= 1) continue;

    const p1 = projectPoint(0, Math.max(z1, 1), cameraX);
    const p2 = projectPoint(0, z2, cameraX);
    if (p2.y >= p1.y) continue; // 奥が手前より下に来ることはない想定（安全策）

    const roadW1 = p1.scale * (CONFIG.road.width / 2) * (W / 2);
    const roadW2 = p2.scale * (CONFIG.road.width / 2) * (W / 2);
    const grassW1 = roadW1 * CONFIG.road.grassFactor;
    const grassW2 = roadW2 * CONFIG.road.grassFactor;
    const rumbleW1 = roadW1 * 1.12;
    const rumbleW2 = roadW2 * 1.12;

    drawQuad(p1.x - grassW1, p1.y, p1.x + grassW1, p1.y, p2.x + grassW2, p2.y, p2.x - grassW2, p2.y, segment.grassColor);
    drawQuad(p1.x - rumbleW1, p1.y, p1.x + rumbleW1, p1.y, p2.x + rumbleW2, p2.y, p2.x - rumbleW2, p2.y, segment.rumbleColor);
    drawQuad(p1.x - roadW1, p1.y, p1.x + roadW1, p1.y, p2.x + roadW2, p2.y, p2.x - roadW2, p2.y, segment.roadColor);

    if (segment.laneOn) {
      const laneW1 = roadW1 * 0.03;
      const laneW2 = roadW2 * 0.03;
      drawQuad(p1.x - laneW1, p1.y, p1.x + laneW1, p1.y, p2.x + laneW2, p2.y, p2.x - laneW2, p2.y, '#cfcf9a');
    }
  }
}

function drawQuad(x1, y1, x2, y2, x3, y3, x4, y4, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x3, y3);
  ctx.lineTo(x4, y4);
  ctx.closePath();
  ctx.fill();
}

function drawHandlebar() {
  const pivotX = W / 2;
  const pivotY = H - 6;
  const barWidth = W * 0.56;
  const barHeight = H * 0.05;

  ctx.save();
  ctx.translate(pivotX, pivotY);
  ctx.rotate(state.handlebarTilt);

  // ステム(支柱)
  ctx.fillStyle = '#04050a';
  ctx.fillRect(-W * 0.02, -barHeight * 2.6, W * 0.04, barHeight * 2.6);

  // ハンドルバー本体
  ctx.strokeStyle = '#06070d';
  ctx.lineWidth = barHeight * 0.9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-barWidth / 2, -barHeight * 2.2);
  ctx.quadraticCurveTo(0, -barHeight * 3.4, barWidth / 2, -barHeight * 2.2);
  ctx.stroke();

  // わずかなハイライト(輪郭が夜でも少し分かるように)
  ctx.strokeStyle = 'rgba(120,132,160,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-barWidth / 2, -barHeight * 2.2 - barHeight * 0.4);
  ctx.quadraticCurveTo(0, -barHeight * 3.4 - barHeight * 0.4, barWidth / 2, -barHeight * 2.2 - barHeight * 0.4);
  ctx.stroke();

  // グリップ
  ctx.fillStyle = '#030408';
  ctx.beginPath();
  ctx.ellipse(-barWidth / 2, -barHeight * 2.2, barHeight * 0.9, barHeight * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(barWidth / 2, -barHeight * 2.2, barHeight * 0.9, barHeight * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function render() {
  drawSky();
  drawGround();
  drawRoad();
  drawHandlebar();
}

// ===== メインループ =====
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  update(dt);
  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame((now) => {
  lastTime = now;
  requestAnimationFrame(loop);
});
