'use strict';
// 双辩手共用的 Live2D 渲染器，支持标准 Cubism 模型。
// 写参数的时机统一在 model.update() 之后、render 之前——这是唯一能稳赢过
// 动作曲线的时点。
(() => {
  const R = (window.AvatarRenderers = window.AvatarRenderers || {});
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);


  // 情绪 → 表情/动作。动作组只有 Idle(idle/dance/jump)、Blink、Nod、Shake。
  const EMOTIONS = {
    neutral:   { expression: null,        motion: null },
    happy:     { expression: '微笑',      motion: null },
    excited:   { expression: '微笑',      motion: ['Idle', 2] },   // jump
    surprised: { expression: '惊讶',      motion: null },
    sad:       { expression: '悲伤',      motion: null },
    angry:     { expression: '生气',      motion: ['Shake', 0] },
    dizzy:     { expression: '悲伤',      motion: ['Shake', 0] },
    shy:       { expression: '微笑',      motion: null },
    smug:      { expression: '微笑',      motion: null },
  };
  const POSE_PARAMS = { yaw: 'ParamAngleX', pitch: 'ParamAngleY', roll: 'ParamAngleZ', gazeX: 'ParamEyeBallX', gazeY: 'ParamEyeBallY' };

  const script = (src) => new Promise((resolve, reject) => {
    const tag = document.createElement('script'); tag.src = src;
    tag.onload = resolve; tag.onerror = () => { tag.remove(); reject(new Error('模型运行文件加载失败：' + src)); };
    document.head.append(tag);
  });
  // 全页共享的加载器（window.__loadLive2dVendor）：core + vendor 全页只允许执行一次。
  // 双方角色必须共用加载链——
  // 各自独立加载会在并行时双重执行 vendor/core，两个 Cubism framework 实例互相踩
  // WASM 函数表，后启动的一方报「Unable to grow wasm table」→「Failed to start up Cubism framework」。
  window.__loadLive2dVendor = window.__loadLive2dVendor || ((async () => {
    if (!window.Live2DCubismCore) await script('/api/avatar/core.js');
    if (!window.__dshLive2dPetVendor) await script('/avatar/live2d/vendor.js');
    const v = window.__dshLive2dPetVendor;
    v.extensions.add(v.Live2DPlugin); v.configureCubismSDK({ memorySizeMB: 64 });
    return v;
  })().catch((error) => { window.__loadLive2dVendor = null; throw error; }));
  const vendor = () => window.__loadLive2dVendor || Promise.reject(new Error('Live2D 加载器未初始化'));

  R.live2d = async (host, config, helpers = {}) => {
    const display = config.display || {};
    const MODEL = config.pack || '/avatar/live2d/doubao/2.0.model3.json';
    const v = await vendor();
    const fetchJson = helpers.fetchJson || ((url, options) => fetch(url, options).then((r) => { if (!r.ok) throw new Error('角色素材加载失败 ' + r.status); return r.json(); }));

    const manifest = await fetchJson(MODEL);
    const base = MODEL.slice(0, MODEL.lastIndexOf('/') + 1);
    // 表情手工套层：不走 expressionManager，Blend 语义自己算。
    const expressions = new Map(await Promise.all((manifest.FileReferences.Expressions || []).map(async (entry) => [entry.Name, await fetchJson(base + entry.File)])));
    const state = { emotion: '', expression: [], motion: null, poseOverride: null, pose: { yaw: 0, pitch: 0, roll: 0, gazeX: 0, gazeY: 0 }, mouthGain: config.mouthGain ?? 1, modelTime: 0, last: null, idle: true };

    const app = new v.Application();
    const width = Math.max(320, (display.charHeight || 335) * 1.9), height = Math.max(260, (display.charHeight || 335) * 1.75);
    await app.init({ width, height, backgroundAlpha: 0, antialias: true, resolution: 2, autoDensity: false, preference: 'webgl', preserveDrawingBuffer: true, autoStart: false });
    // Backing pixels are doubled for sharpness; CSS must retain the logical size.
    app.canvas.style.width='100%';app.canvas.style.height='100%';
    const wrap = document.createElement('div'); wrap.className = 'mesh-rig live2d-rig';
    wrap.style.cssText = `position:absolute;left:${(display.anchorX || 0) - width / 2}px;top:${(display.anchorY || 0) - height}px;width:${width}px;height:${height}px;pointer-events:none;`;
    wrap.append(app.canvas); host.append(wrap);

    const model = await v.Live2DModel.from(MODEL, { autoUpdate: false, autoFocus: false, autoHitTest: false, eyeBlink: false, textureOptions: { lod: 'full' } });
    app.stage.addChild(model);
    const internal = model.internalModel, core = internal.coreModel;
    const params = core._model.parameters;
    const ids = new Map(Array.from(params.ids).map((id, index) => [id, index]));
    const range = (id) => { const i = ids.get(id); if (i === undefined) return [-1, 1]; return [params.minimumValues[i], params.maximumValues[i]]; };

    const modelHeight = internal.originalHeight || model.height;
    model.anchor.set(0.5, 1);
    model.scale.set(clamp((display.charHeight || 335) / modelHeight, 0.05, 4));
    model.position.set(width / 2, height - 6);

    // 预载动作，避免快速切表情时旧动作的异步加载反过来覆盖新动作。
    await Promise.all(Object.keys(manifest.FileReferences.Motions || {}).map((group) => internal.motionManager.loadMotion(group, 0)));
    const idle = (loop = true) => model.motion('Idle', 0, v.MotionPriority.FORCE, { loop }).catch(() => {});
    idle(true);
    // 一次性动作的完成判定：优先问 motionManager，问不到就按估时兜底。
    const motionDone = () => {
      const manager = internal.motionManager;
      if (typeof manager.isFinished === 'function') return manager.isFinished();
      return !state.motionAt || state.modelTime - state.motionAt > state.motionDur;
    };

    const setValue = (id, value) => { const i = ids.get(id); if (i !== undefined) params.values[i] = Math.max(params.minimumValues[i], Math.min(params.maximumValues[i], value)); };

    const setEmotion = (emotion) => {
      if (own(EMOTIONS, emotion) === false || emotion === state.emotion) return;
      state.emotion = emotion;
      const spec = EMOTIONS[emotion] || EMOTIONS.neutral;
      state.expression = spec.expression ? (expressions.get(spec.expression)?.Parameters || []) : [];
      if (state.motion) state.motion = null;
      if (spec.motion && manifest.FileReferences.Motions?.[spec.motion[0]]?.[spec.motion[1]] && !state.poseOverride) { state.motion = spec.motion; state.motionAt = state.modelTime; state.motionDur = 2.4; model.motion(spec.motion[0], spec.motion[1], v.MotionPriority.FORCE, { loop: false }).catch(() => {}); }
    };
    let disposed = false;
    return {
      kind: 'live2d',
      start() {},
      dispose() { disposed = true; try { app.destroy({ removeView: true }, { children: true }); } catch {} wrap.remove(); },
      speechStart(emotion) { setEmotion(emotion); },
      speechEnd() {},
      playEmotion: setEmotion,
      setPose(pose = {}) {
        state.poseOverride = Object.fromEntries(Object.entries(pose).filter(([key, value]) => own(POSE_PARAMS, key) && typeof value === 'number' && Number.isFinite(value)));
        // 打工看屏：停掉 idle（它的曲线会盖过姿势），由本渲染器自己供呼吸。
        if (state.poseOverride && Object.keys(state.poseOverride).length) {
          if (state.idle) { internal.motionManager.stopAllMotions?.(); state.idle = false; state.motion = null; }
        } else if (!state.idle && !state.motion) { state.idle = true; idle(true); }
      },
      getPose() { return { ...state.pose }; },
      // 调试出口：headless 验证（tools/debug-page.mjs + 临时测试页）直接采样参数值用。
      __debugParams: params,
      frame(t, level) {
        if (disposed) throw new Error('Live2D 渲染器已销毁，请刷新形象源重建。');
        const rawDt = state.last === null ? 1 / 60 : t - state.last;
        if (state.last !== null && rawDt < 1 / 60 - 0.001) return;             // 帧率限制（OBS 捕获沿用上一帧）
        state.last = t;
        const dt = clamp(rawDt, 0.001, 1 / 15);
        if (rawDt > 0.0005) { state.modelTime += dt; model.update(dt * 1000); }  // 暂停时 t 不再增长 → 冻结动作，只留最后一帧
        // 一次性动作播完 → 回 idle（打工姿势覆盖中除外）
        if (!state.poseOverride && state.motion && motionDone()) { state.motion = null; state.idle = true; idle(true); }
        // --- 以下写入都在动作求值之后，稳赢曲线 ---
        // 眨眼（模型 idle 曲线里有眼开合，所以放在 update 后写才能生效）
        const blink = state.modelTime % 4.7;
        const eyeValue = blink < 0.12 ? 0.1 : 1;
        setValue('ParamEyeLOpen', eyeValue); setValue('ParamEyeROpen', eyeValue);
        // 表情层（Overwrite/Add/Multiply，作用在眨眼后的当前值上）
        for (const row of state.expression) {
          const i = ids.get(row.Id); if (i === undefined) continue;
          const value = row.Blend === 'Multiply' ? params.values[i] * row.Value : row.Blend === 'Add' ? params.values[i] + row.Value : row.Value;
          params.values[i] = Math.max(params.minimumValues[i], Math.min(params.maximumValues[i], value));
        }
        // 打工姿势：头部转向 + 眼球 + 自供呼吸（idle 已停）
        // 符号：rig 的 pitch/gazeY 正值=往下看，而 Live2D 的 AngleY/EyeBallY 正值=抬头，取反对齐；
        // yaw/gazeX/roll 正负号两边一致，直接映射。
        const SIGN = { yaw: 1, pitch: -1, roll: 1, gazeX: 1, gazeY: -1 };
        if (state.poseOverride) {
          for (const [key, id] of Object.entries(POSE_PARAMS)) if (own(state.poseOverride, key)) { const [lo, hi] = range(id); setValue(id, clamp(state.poseOverride[key] * SIGN[key], -1, 1) * Math.max(Math.abs(lo), Math.abs(hi))); }
          state.pose = { ...state.pose, ...state.poseOverride };
          const [lo, hi] = range('ParamBreath'); setValue('ParamBreath', lo + (hi - lo) * (0.5 + 0.35 * Math.sin(state.modelTime * (Math.PI * 2 / 3.4))));
        }
        // 口型：电平 × 3.5Hz 开合包络（半波正弦，每秒 3.5 次一开一合），直接覆写——
        // 不能用「底噪 + 电平增益」的加法：电平稍高就饱和在上限，嘴一直张着。
        // 5Hz 实测偏快（用户反馈），降到 3.5Hz 更接近自然语速。
        const flap = Math.max(0, Math.sin(state.modelTime * Math.PI * 2 * 3.5));
        setValue('ParamMouthOpenY', level > 0.02 ? clamp(0.2 + level * 1.4) * flap * state.mouthGain : 0);
        app.renderer.render(app.stage);
      },
    };
  };
})();
