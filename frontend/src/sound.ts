// sound.ts — audio manager.
//
// Two independent volume levels (sound effects & music), persisted in
// localStorage. Background music is a looping <audio> element; every other cue
// is played from a small pool of elements so rapid collisions can overlap.
//
// Drop your own sound files into frontend/audio/ and keep the filenames below
// (or edit this map). "miss" plays a RANDOM file from the audio/miss folder —
// add more files there and append their names to AUDIO.miss.

const SFX_VOL_KEY = 'neonpong.vol.sfx';
const MUSIC_VOL_KEY = 'neonpong.vol.music';

export const AUDIO = {
  music: 'audio/music.wav',
  hitWall: 'audio/hit-wall.wav',
  hitPaddle: 'audio/hit-paddle.wav',
  click: 'audio/click.wav',
  win: 'audio/win.wav',
  miss: ['audio/miss/miss-1.wav', 'audio/miss/miss-2.wav', 'audio/miss/miss-3.wav'],
} as const;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

function loadVol(key: string, dflt: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? '');
  return isFinite(v) ? clamp01(v) : dflt;
}
function saveVol(key: string, v: number): void {
  localStorage.setItem(key, String(clamp01(v)));
}

class SoundManager {
  private sfxVol = loadVol(SFX_VOL_KEY, 0.8);
  private musicVol = loadVol(MUSIC_VOL_KEY, 0.55);
  private musicEl: HTMLAudioElement | null = null;
  private pools = new Map<string, HTMLAudioElement[]>();
  private lastSfx = 0;
  private lastClick = 0;
  private started = false;

  constructor() {
    // Browsers only start audio after a user gesture: unlock + start the music
    // on the first interaction with the page.
    const unlock = (): void => {
      if (!this.started) {
        this.started = true;
        this.startMusic();
      }
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });

    // Button presses (menu / lobby / game-over) -> click cue.
    window.addEventListener(
      'click',
      (e) => {
        const t = e.target as Element | null;
        if (t && (t.tagName === 'BUTTON' || t.classList.contains('btn'))) this.click();
      },
      { passive: true },
    );
  }

  get sfxVolume(): number {
    return this.sfxVol;
  }
  get musicVolume(): number {
    return this.musicVol;
  }

  setSfxVolume(v: number): void {
    this.sfxVol = clamp01(v);
    saveVol(SFX_VOL_KEY, this.sfxVol);
  }

  setMusicVolume(v: number): void {
    this.musicVol = clamp01(v);
    saveVol(MUSIC_VOL_KEY, this.musicVol);
    if (this.musicEl) this.musicEl.volume = this.musicVol;
    if (this.started) this.startMusic();
  }

  /** Starts looping background music (safe to call repeatedly). */
  startMusic(): void {
    if (!this.musicEl) {
      const m = new Audio(AUDIO.music);
      m.loop = true;
      m.preload = 'auto';
      m.volume = this.musicVol;
      this.musicEl = m;
    }
    const m = this.musicEl;
    if (this.musicVol <= 0) {
      m.pause();
      return;
    }
    if (m.paused) m.play().catch(() => {});
  }

  /** Play a pooled cue; returns immediately if throttled or muted. */
  private sfx(file: string, pitch: number, minGapMs: number): void {
    const now = performance.now();
    if (now - this.lastSfx < minGapMs || this.sfxVol <= 0) return;
    this.lastSfx = now;

    let pool = this.pools.get(file);
    if (!pool) {
      pool = [];
      this.pools.set(file, pool);
    }
    let el = pool.find((a) => a.paused || a.ended);
    if (!el) {
      if (pool.length >= 6) return; // too many simultaneous voices -> drop
      el = new Audio(file);
      pool.push(el);
    }
    el.volume = this.sfxVol;
    if (pitch !== 1) el.playbackRate = pitch;
    el.currentTime = 0;
    el.play().catch(() => {});
  }

  /** Ball hit a plain wall. */
  hitWall(): void {
    this.sfx(AUDIO.hitWall, 0.95 + Math.random() * 0.12, 30);
  }
  /** Ball hit a paddle. */
  hitPaddle(): void {
    this.sfx(AUDIO.hitPaddle, 0.9 + Math.random() * 0.2, 40);
  }
  /** UI button click. */
  click(): void {
    const now = performance.now();
    if (now - this.lastClick < 70) return;
    this.lastClick = now;
    this.sfx(AUDIO.click, 1, 0);
  }
  /** Match won. */
  win(): void {
    this.sfx(AUDIO.win, 1, 0);
  }
  /** "You let the ball in" — random file from the miss folder. */
  miss(): void {
    const list = AUDIO.miss;
    if (list.length === 0) return;
    const f = list[Math.floor(Math.random() * list.length)];
    this.sfx(f, 1, 0);
  }
}

export const sound = new SoundManager();
