/**
 * VRM stage controller — one renderer, one avatar, six moods.
 * Spec: docs/RESIDENTS.md §5 "VRM stage".
 *
 * Body clips are `.vrma` (not Unity `.anim`). In profit (`smug`) the preset
 * dance plays on a loop. Otherwise — including Resting with no live agent —
 * the stage shuffles `IDLE_ANIMS` so visitors always see motion. Bind / T-pose
 * is never shown: VRoid rest crops out of a portrait camera. Orbit is Hub-style.
 * Keep this file free of React.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip, type VRMAnimation } from '@pixiv/three-vrm-animation';
import { FALLBACK_ANIM, IDLE_ANIMS, type ResidentMood } from '../../lib/residents';

export const ANIM_BASE = '/resident/anims';
export { FALLBACK_ANIM, IDLE_ANIMS };
const CROSSFADE_S = 0.45;
const IDLE_GAP_S = 0.45;
const MAX_PIXEL_RATIO = 1.75;

type LogicalExpr = 'happy' | 'angry' | 'sad' | 'relaxed' | 'surprised' | 'blink' | 'lookDown' | 'neutral' | 'aa';

interface MoodProfile {
  /** Breaths per minute — drives the procedural chest/spine cycle. */
  breathBpm: number;
  /** Radians of head nod (x) and tilt (z) at rest. */
  headX: number;
  headZ: number;
  /** Forward lean of the spine in radians. */
  spineX: number;
  /** Shoulder shrug (upper-arm z rotation), radians. */
  shrug: number;
  /** Logical expression weights. Bound to whatever names this VRM actually has. */
  expressions: Partial<Record<LogicalExpr, number>>;
  /** Blink cadence range in seconds. Null = hold `blinkHold` (sleep = eyes shut). */
  blinkEvery: [number, number] | null;
  blinkHold?: number;
  /** How much the head follows the pointer (0 = ignore). */
  lookAt: number;
}

const MOODS: Record<ResidentMood, MoodProfile> = {
  idle: { breathBpm: 13, headX: 0, headZ: 0, spineX: 0, shrug: 0, expressions: {}, blinkEvery: [2.5, 6], lookAt: 0.6 },
  focused: { breathBpm: 15, headX: 0.12, headZ: 0.03, spineX: 0.08, shrug: 0, expressions: { lookDown: 0.35 }, blinkEvery: [4, 8], lookAt: 0.15 },
  tense: { breathBpm: 22, headX: 0.05, headZ: -0.05, spineX: 0.05, shrug: 0.08, expressions: { angry: 0.45, sad: 0.28 }, blinkEvery: [1.5, 3.5], lookAt: 0.3 },
  smug: { breathBpm: 12, headX: -0.08, headZ: 0.1, spineX: -0.04, shrug: 0, expressions: { happy: 0.72, relaxed: 0.22 }, blinkEvery: [3, 7], lookAt: 0.7 },
  shrug: { breathBpm: 14, headX: 0.02, headZ: 0.12, spineX: 0, shrug: 0.32, expressions: { surprised: 0.4, happy: 0.12 }, blinkEvery: [2, 5], lookAt: 0.4 },
  sleep: { breathBpm: 8, headX: 0.35, headZ: 0.08, spineX: 0.12, shrug: 0, expressions: {}, blinkEvery: null, blinkHold: 1, lookAt: 1 },
};

/** VRM 0 Hub names (joy/fun/sorrow) already remap in three-vrm; Surprised stays custom. */
const EXPR_ALIASES: Record<LogicalExpr, string[]> = {
  happy: ['happy', 'joy'],
  angry: ['angry'],
  sad: ['sad', 'sorrow'],
  relaxed: ['relaxed', 'fun'],
  surprised: ['surprised'],
  blink: ['blink'],
  lookDown: ['lookdown', 'look_down', 'lookDown'],
  neutral: ['neutral'],
  aa: ['aa', 'a'],
};

export type StageStatus = 'idle' | 'loading' | 'ready' | 'error';

export class VrmStageController {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  private readonly loader: GLTFLoader;
  /** True after the user pans / orbits / zooms — resize must not snap back. */
  private orbitUser = false;
  private vrm: VRM | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private clipByFile = new Map<string, THREE.AnimationClip | null>();
  private actionByFile = new Map<string, THREE.AnimationAction>();
  private currentFile: string | null = null;
  private rotatingIdle = false;
  private nextIdleAt = 0;
  private fallbackAnim = FALLBACK_ANIM;
  private idleAnims: readonly string[] = IDLE_ANIMS;
  private current: THREE.AnimationAction | null = null;
  private mood: ResidentMood = 'idle';
  private frame = 0;
  private disposed = false;
  private pointer = new THREE.Vector2(0, 0);
  private lookTarget = new THREE.Object3D();
  private readonly camRight = new THREE.Vector3();
  private readonly camUp = new THREE.Vector3();
  private nextBlinkAt = 2;
  private blinkPhase = 0;
  private speakPhase = 0;
  private speaking = false;
  private expressionWeights = new Map<LogicalExpr, number>();
  /** logical Hub/VRM1 name → actual key on this file (`Surprised`, `happy`, …). */
  private exprAlias = new Map<LogicalExpr, string>();
  private restPose = new Map<string, THREE.Quaternion>();
  private currentModelUrl: string | null = null;
  status: StageStatus = 'idle';
  onStatus: ((s: StageStatus, err?: unknown) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES crushes MToon to black — three-vrm examples use no tone mapping.
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 40);
    this.camera.position.set(0, 1.25, 2);
    this.camera.lookAt(0, 1.2, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x887766, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(0.4, 1.6, 2.4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xfff4e8, 0.9);
    fill.position.set(-1.4, 1.2, 1.2);
    this.scene.add(fill);
    this.scene.add(this.lookTarget);
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('contextmenu', this.onContextMenu);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.rotateSpeed = 0.72;
    this.controls.panSpeed = 0.85;
    this.controls.zoomSpeed = 0.9;
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    this.controls.enableRotate = true;
    this.controls.minPolarAngle = 0.18;
    this.controls.maxPolarAngle = Math.PI * 0.82;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.controls.enabled = false;
    this.controls.addEventListener('start', this.onOrbitStart);
    this.canvas.addEventListener('dblclick', this.onDblClick);

    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Hover offset on top of the camera lock (-1..1). Orbit does not clear it. */
  setPointer(x: number, y: number): void {
    this.pointer.set(THREE.MathUtils.clamp(x, -1, 1), THREE.MathUtils.clamp(y, -1, 1));
  }

  setSpeaking(on: boolean): void {
    this.speaking = on;
  }

  setFallbackAnim(file: string): void {
    const next = file.trim() || FALLBACK_ANIM;
    if (next === this.fallbackAnim) return;
    this.clipByFile.delete(this.fallbackAnim);
    this.actionByFile.delete(this.fallbackAnim);
    this.fallbackAnim = next;
    if (this.vrm) void this.applyMood(this.mood, true);
  }

  setIdleAnims(files: readonly string[]): void {
    const next = files.length ? files : IDLE_ANIMS;
    if (next.length === this.idleAnims.length && next.every((file, i) => file === this.idleAnims[i])) return;
    this.idleAnims = next;
    if (this.rotatingIdle && this.vrm) void this.playNextIdle(true);
  }

  resize(): void {
    const parent = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, Math.round(parent.clientWidth));
    const h = Math.max(1, Math.round(parent.clientHeight));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.vrm && !this.orbitUser) this.frameCamera(this.vrm);
    else this.controls.update();
  }

  async load(modelUrl: string): Promise<void> {
    if (this.currentModelUrl === modelUrl && (this.vrm || this.status === 'loading')) return;
    this.currentModelUrl = modelUrl;
    this.setStatus('loading');
    this.unloadVrm();
    try {
      const gltf = await this.loader.loadAsync(modelUrl);
      if (this.disposed || this.currentModelUrl !== modelUrl) return;
      const vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) throw new Error('Not a VRM file');
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm);
      vrm.scene.traverse((o) => {
        o.frustumCulled = false;
      });
      this.vrm = vrm;
      vrm.scene.visible = false;
      this.scene.add(vrm.scene);
      this.captureRestPose(vrm);
      this.bindExpressions(vrm);
      this.widenLook(vrm);
      if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;
      this.mixer = new THREE.AnimationMixer(vrm.scene);
      this.mixer.addEventListener('finished', this.onClipFinished);
      this.current = null;
      this.currentFile = null;
      vrm.update(0);
      this.orbitUser = false;
      this.resize();
      await this.preloadIdleClips();
      if (this.disposed || this.currentModelUrl !== modelUrl) return;
      await this.applyMood(this.mood, true);
      if (this.disposed || this.currentModelUrl !== modelUrl) return;
      this.poseAndReveal();
    } catch (err) {
      if (this.disposed) return;
      this.setStatus('error', err);
    }
  }

  setMood(mood: ResidentMood): void {
    if (mood === this.mood && this.status === 'ready') return;
    this.mood = mood;
    if (this.vrm) void this.applyMood(mood, false);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    this.controls.removeEventListener('start', this.onOrbitStart);
    this.controls.dispose();
    this.unloadVrm();
    this.renderer.dispose();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private setStatus(s: StageStatus, err?: unknown): void {
    this.status = s;
    this.onStatus?.(s, err);
  }

  private unloadVrm(): void {
    this.rotatingIdle = false;
    this.nextIdleAt = 0;
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.onClipFinished);
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.clipByFile.clear();
    this.actionByFile.clear();
    this.currentFile = null;
    this.current = null;
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.restPose.clear();
    this.exprAlias.clear();
    this.expressionWeights.clear();
    this.controls.enabled = false;
    this.orbitUser = false;
  }

  private captureRestPose(vrm: VRM): void {
    const names = ['head', 'neck', 'spine', 'chest', 'upperChest', 'leftUpperArm', 'rightUpperArm', 'leftShoulder', 'rightShoulder'] as const;
    for (const name of names) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (node) this.restPose.set(name, node.quaternion.clone());
    }
  }

  /** Use only presets this file has. Match Hub sliders case-insensitively. */
  private bindExpressions(vrm: VRM): void {
    this.exprAlias.clear();
    const em = vrm.expressionManager;
    if (!em) return;
    const byLower = new Map<string, string>();
    for (const key of Object.keys(em.expressionMap ?? {})) {
      byLower.set(key.toLowerCase(), key);
    }
    (Object.keys(EXPR_ALIASES) as LogicalExpr[]).forEach((logical) => {
      for (const cand of EXPR_ALIASES[logical]) {
        const hit = byLower.get(cand.toLowerCase());
        if (hit) {
          this.exprAlias.set(logical, hit);
          return;
        }
      }
    });
  }

  private setExpr(vrm: VRM, logical: LogicalExpr, weight: number): void {
    const actual = this.exprAlias.get(logical);
    if (!actual || !vrm.expressionManager) return;
    vrm.expressionManager.setValue(actual, THREE.MathUtils.clamp(weight, 0, 1));
  }

  /**
   * Chest-up portrait from head/hips (same crop as the poster).
   * Ignores T-pose arm span and spring-bone helpers — those inflate AABB and
   * shove the body out of a tight FOV.
   */
  private frameCamera(vrm: VRM): void {
    vrm.scene.updateMatrixWorld(true);
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    const hips = vrm.humanoid.getNormalizedBoneNode('hips');
    const headPos = new THREE.Vector3();
    const hipPos = new THREE.Vector3();
    if (head) headPos.setFromMatrixPosition(head.matrixWorld);
    else headPos.set(0, 1.4, 0);
    if (hips) hipPos.setFromMatrixPosition(hips.matrixWorld);
    else hipPos.set(0, 0.9, 0);

    const focus = new THREE.Vector3(
      (headPos.x + hipPos.x) * 0.5,
      hipPos.y + (headPos.y - hipPos.y) * 0.88,
      (headPos.z + hipPos.z) * 0.5,
    );
    const span = Math.max(0.4, headPos.y - hipPos.y);
    const fovY = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (span * 1.05) / Math.tan(fovY / 2);

    this.camera.near = 0.05;
    this.camera.far = Math.max(20, dist * 8);
    this.camera.up.set(0, 1, 0);
    this.camera.position.set(focus.x, focus.y, focus.z + dist);
    this.camera.lookAt(focus);
    this.camera.updateProjectionMatrix();
    this.lookTarget.position.set(focus.x, headPos.y, focus.z + dist);
    this.controls.target.copy(focus);
    this.controls.minDistance = dist * 0.42;
    this.controls.maxDistance = dist * 3.4;
    this.controls.update();
    this.controls.saveState();
  }

  private async applyMood(mood: ResidentMood, immediate: boolean): Promise<void> {
    const vrm = this.vrm;
    if (!vrm || !this.mixer) return;
    this.nextIdleAt = 0;
    if (mood === 'smug') {
      this.rotatingIdle = false;
      await this.playFile(this.fallbackAnim, { loop: true, immediate });
      return;
    }
    this.rotatingIdle = true;
    await this.playNextIdle(immediate);
  }

  private async preloadIdleClips(): Promise<void> {
    await Promise.all(this.idleAnims.map((file) => this.ensureClip(file)));
  }

  private async ensureClip(file: string): Promise<THREE.AnimationClip | null> {
    if (this.clipByFile.has(file)) return this.clipByFile.get(file) ?? null;
    const clip = await this.loadVrmaClip(`${ANIM_BASE}/${file}`);
    this.clipByFile.set(file, clip);
    return clip;
  }

  private idlePool(): string[] {
    return this.idleAnims.filter((file) => this.clipByFile.get(file));
  }

  private async playNextIdle(immediate: boolean): Promise<void> {
    if (!this.rotatingIdle || this.mood === 'smug') return;
    const available = this.idlePool();
    if (!available.length) {
      await this.preloadIdleClips();
    }
    const pool = this.idlePool();
    if (!pool.length) {
      this.stopClip(immediate);
      return;
    }
    const choices = pool.filter((file) => file !== this.currentFile);
    const pick = choices.length ? choices : pool;
    const next = pick[Math.floor(Math.random() * pick.length)];
    await this.playFile(next, { loop: false, immediate });
  }

  private async playFile(
    file: string,
    opts: { loop: boolean; immediate: boolean },
  ): Promise<boolean> {
    if (!this.mixer || !this.vrm) return false;
    const clip = await this.ensureClip(file);
    if (!clip || this.disposed) return false;
    if (opts.loop ? this.mood !== 'smug' : !this.rotatingIdle) return false;
    let action = this.actionByFile.get(file);
    if (!action) {
      action = this.mixer.clipAction(clip);
      this.actionByFile.set(file, action);
    }
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    if (clip.duration > 0.08) action.time = Math.min(1 / 24, clip.duration * 0.03);
    if (opts.loop) {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    } else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    action.timeScale = 1;
    action.play();
    if (this.current && this.current !== action) {
      if (opts.immediate) this.current.stop();
      else this.current.crossFadeTo(action, CROSSFADE_S, true);
    }
    this.current = action;
    this.currentFile = file;
    this.mixer.update(0);
    this.vrm.update(0);
    return true;
  }

  /** First paint must already be a clip pose — never flash VRoid T-pose under the poster. */
  private poseAndReveal(): void {
    const vrm = this.vrm;
    if (!vrm) return;
    if (!this.current) this.procedural(vrm, 0, 1);
    this.mixer?.update(0);
    vrm.update(0);
    vrm.scene.visible = true;
    this.frameCamera(vrm);
    this.controls.enabled = true;
    this.renderer.render(this.scene, this.camera);
    this.setStatus('ready');
  }

  private stopClip(immediate: boolean): void {
    if (!this.current) return;
    if (immediate) this.current.stop();
    else this.current.fadeOut(CROSSFADE_S);
    this.current = null;
    this.currentFile = null;
  }

  private onClipFinished = (e: { action?: THREE.AnimationAction }): void => {
    if (!this.rotatingIdle || e.action !== this.current) return;
    this.nextIdleAt = this.clock.elapsedTime + IDLE_GAP_S;
  };

  private async loadVrmaClip(url: string): Promise<THREE.AnimationClip | null> {
    try {
      const gltf = await this.loader.loadAsync(url);
      const anims = (gltf.userData.vrmAnimations ?? []) as VRMAnimation[];
      if (!anims.length || !this.vrm) return null;
      return createVRMAnimationClip(anims[0], this.vrm);
    } catch {
      return null;
    }
  }

  private tick = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    const vrm = this.vrm;
    if (vrm?.scene.visible) {
      this.mixer?.update(dt);
      if (this.rotatingIdle && this.nextIdleAt > 0 && t >= this.nextIdleAt) {
        this.nextIdleAt = 0;
        void this.playNextIdle(false);
      }
      if (!this.current) this.procedural(vrm, t, dt);
      this.face(vrm, t, dt);
      this.aimLook(vrm);
      vrm.update(dt);
    }
    if (this.disposed) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private onOrbitStart = (): void => {
    this.orbitUser = true;
  };

  private onDblClick = (): void => {
    this.orbitUser = false;
    if (this.vrm) this.frameCamera(this.vrm);
  };

  /** Breathing + posture when no clip is playing for this mood. */
  private procedural(vrm: VRM, t: number, dt: number): void {
    const p = MOODS[this.mood];
    const breath = Math.sin((t * p.breathBpm * Math.PI * 2) / 60);
    const ease = 1 - Math.exp(-dt * 4);
    const set = (name: 'head' | 'neck' | 'spine' | 'chest' | 'upperChest' | 'leftUpperArm' | 'rightUpperArm' | 'leftShoulder' | 'rightShoulder', x: number, y: number, z: number) => {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      const rest = this.restPose.get(name);
      if (!node || !rest) return;
      const target = rest.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)));
      node.quaternion.slerp(target, ease);
    };
    const sway = Math.sin(t * 0.37) * 0.03;
    set('spine', p.spineX + breath * 0.012, sway * 0.5, 0);
    set('chest', breath * 0.02, 0, 0);
    set('upperChest', breath * 0.015, 0, 0);
    set('neck', p.headX * 0.4, sway, p.headZ * 0.4);
    set('head', p.headX * 0.6 + Math.sin(t * 0.61) * 0.015, this.pointer.x * 0.25 * p.lookAt + sway, p.headZ * 0.6 + Math.sin(t * 0.43) * 0.01);
    // Shrug: raise both shoulders, rotate upper arms outward a touch.
    set('leftShoulder', 0, 0, p.shrug * 0.6);
    set('rightShoulder', 0, 0, -p.shrug * 0.6);
    set('leftUpperArm', 0, 0, p.shrug + breath * 0.004);
    set('rightUpperArm', 0, 0, -(p.shrug + breath * 0.004));
  }

  /** Expression presets, blinking and a cheap mouth flap while "speaking". */
  private face(vrm: VRM, t: number, dt: number): void {
    if (!vrm.expressionManager) return;
    const p = MOODS[this.mood];
    const ease = 1 - Math.exp(-dt * 6);
    const overlay = new Set<LogicalExpr>(['blink', 'aa']);
    for (const logical of this.exprAlias.keys()) {
      if (overlay.has(logical)) continue;
      const target = p.expressions[logical] ?? 0;
      const cur = this.expressionWeights.get(logical) ?? 0;
      const next = cur + (target - cur) * ease;
      this.expressionWeights.set(logical, next);
      this.setExpr(vrm, logical, next);
    }
    if (p.blinkHold != null && !this.current) {
      this.setExpr(vrm, 'blink', p.blinkHold);
    } else if (p.blinkEvery) {
      if (t >= this.nextBlinkAt) {
        this.blinkPhase = 0.001;
        const [lo, hi] = p.blinkEvery;
        this.nextBlinkAt = t + lo + Math.random() * (hi - lo);
      }
      if (this.blinkPhase > 0) {
        this.blinkPhase += dt * 9;
        const v = Math.sin(Math.min(Math.PI, this.blinkPhase));
        this.setExpr(vrm, 'blink', v);
        if (this.blinkPhase >= Math.PI) this.blinkPhase = 0;
      } else {
        this.setExpr(vrm, 'blink', 0);
      }
    } else {
      this.setExpr(vrm, 'blink', 0);
    }
    const mouthTarget = this.speaking ? 0.25 + 0.35 * Math.abs(Math.sin(t * 9.1) * Math.sin(t * 5.3)) : 0;
    this.speakPhase += (mouthTarget - this.speakPhase) * (1 - Math.exp(-dt * 12));
    this.setExpr(vrm, 'aa', this.speakPhase);
  }

  /**
   * VRM look curves cap horizontal eye travel much sooner than vertical, so a
   * left/right orbit pinned the gaze while up/down still followed. Widen yaw
   * so the eyes keep tracking the camera.
   */
  private widenLook(vrm: VRM): void {
    const applier = vrm.lookAt?.applier as {
      type?: string;
      rangeMapHorizontalInner?: { inputMaxValue: number; outputScale: number };
      rangeMapHorizontalOuter?: { inputMaxValue: number; outputScale: number };
    } | undefined;
    if (!applier) return;
    const bone = applier.type === 'bone';
    for (const map of [applier.rangeMapHorizontalInner, applier.rangeMapHorizontalOuter]) {
      if (!map) continue;
      if (bone) {
        map.inputMaxValue = 120;
        map.outputScale = 120;
      } else {
        map.inputMaxValue = 32;
        map.outputScale = 1;
      }
    }
  }

  /**
   * Eyes stay on the screen in every mood. The look target is the camera, so
   * orbiting the body does not turn the gaze away. A small pointer offset
   * still follows the cursor.
   */
  private aimLook(vrm: VRM): void {
    if (!vrm.lookAt) return;
    vrm.scene.updateMatrixWorld(true);
    this.lookTarget.position.copy(this.camera.position);
    this.camRight.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.camUp.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.lookTarget.position.addScaledVector(this.camRight, this.pointer.x * 0.18);
    this.lookTarget.position.addScaledVector(this.camUp, this.pointer.y * 0.12);
  }
}
