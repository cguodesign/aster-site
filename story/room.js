/* The study-room story in three.js: one GLB and one timeline JSON (both written by
   site/models/study-room/export-web.py), driven by a frame number 1-451.

   Nothing here runs on its own clock: the page calls setFrame(f) with a (fractional) frame and
   render() when it needs a picture. Same shot list as the video (STORY-SHOTS.md). */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const DATA = new URL('../models/study-room/web/', import.meta.url);

/* ---------------------------------------------------------------- timeline helpers */
function linear(points) {
  // points: [[frame, value], ...], value a number or an array. Returns f -> value.
  const n = points.length;
  const isArr = Array.isArray(points[0][1]);
  const out = isArr ? points[0][1].slice() : 0;
  return (f) => {
    if (f <= points[0][0]) return isArr ? (out.splice(0, out.length, ...points[0][1]), out) : points[0][1];
    if (f >= points[n - 1][0]) return isArr ? (out.splice(0, out.length, ...points[n - 1][1]), out) : points[n - 1][1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m][0] <= f) lo = m; else hi = m; }
    const [fa, a] = points[lo], [fb, b] = points[hi];
    const t = (f - fa) / (fb - fa);
    if (!isArr) return a + (b - a) * t;
    for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
    return out;
  };
}
function step(points) {
  const n = points.length;
  return (f) => {
    const fi = Math.floor(f + 1e-4);
    if (fi < points[0][0]) return points[0][1];
    let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (points[m][0] <= fi) lo = m; else hi = m; }
    return points[lo][1];
  };
}

/* ---------------------------------------------------------------- shared shader pieces */
const GLSL_COMMON = /* glsl */`
uniform vec3 uBand0; uniform vec3 uBand1; uniform vec3 uBand2; uniform vec3 uBand3;
uniform vec3 uThresh; uniform float uHueKeep; uniform float uSat; uniform float uDebugL;
uniform vec3 uHazeMin; uniform vec3 uHazeMax; uniform float uHazeDensity; uniform vec3 uHazeColor;
varying vec3 vWPos;
vec3 hsvSat(vec3 c, float s) {
  // Blender's Hue/Saturation node: scale HSV saturation.
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  if (mx <= 0.0) return c;
  float sat = (mx - mn) / mx;
  float ns = clamp(sat * s, 0.0, 1.0);
  if (sat <= 0.0) return c;
  // keep hue and value: move each channel toward the max by the saturation ratio
  return mx - (mx - c) * (ns / sat);
}
float hazeAmount(vec3 p) {
  vec3 ro = cameraPosition; vec3 d = p - ro; float len = length(d);
  if (len < 1e-4 || uHazeDensity <= 0.0) return 0.0;
  vec3 rd = d / len;
  vec3 inv = 1.0 / (abs(rd) + 1e-6) * sign(rd + 1e-9);
  vec3 t0 = (uHazeMin - ro) * inv, t1 = (uHazeMax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float a = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  float b = min(min(tmax.x, tmax.y), min(tmax.z, len));
  return 1.0 - exp(-uHazeDensity * max(b - a, 0.0));
}
vec3 applyHaze(vec3 c, vec3 p) { return mix(c, uHazeColor, hazeAmount(p)); }
`;

function makeUniforms(TL) {
  const v3 = () => ({ value: new THREE.Vector3() });
  const t = TL.toon;
  return {
    uBand0: v3(), uBand1: v3(), uBand2: v3(), uBand3: v3(),
    uThresh: { value: new THREE.Vector3(...t.thresholds) },
    uHueKeep: { value: t.hue_keep }, uSat: { value: t.albedo_sat }, uDebugL: { value: 0 },
    uHazeMin: { value: new THREE.Vector3(...TL.haze.box_min) },
    uHazeMax: { value: new THREE.Vector3(...TL.haze.box_max) },
    uHazeDensity: { value: 0 }, uHazeColor: { value: new THREE.Color() },
    uPage: { value: new Float32Array(8) },
    uApt: { value: null },
    uShadeInside: { value: new THREE.Color().setRGB(...TL.glass.shade_inside) },
  };
}

/* Toon: MeshLambertMaterial does the lights and shadow maps; the patch keeps the light colour
   L (diffuse colour forced to white), picks one of four band colours from its luminance and
   multiplies it with the base colour, as story-style.py does in Blender:
     out = sat(base, S) * band(lum(L)) * mix(1, L / lum(L), H) + emission
   Area lights come in as spot lights; the patch gives them Blender's cosine falloff. */
function toonMaterial(kind, map, U, extra = {}) {
  const m = new THREE.MeshLambertMaterial({ map, vertexColors: true, side: THREE.DoubleSide, ...extra });
  const local = { uEmitScale: { value: 1 } };
  m.userData.uniforms = local;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, local);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 _emit;\nvarying vec4 vEmit;\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvEmit = _emit;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    const pars = THREE.ShaderChunk.lights_pars_begin.replace(
      'return smoothstep( coneCosine, penumbraCosine, angleCosine );',
      'return max(angleCosine, 0.0) * smoothstep( coneCosine, penumbraCosine, angleCosine );');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_COMMON +
        'varying vec4 vEmit;\nuniform float uPage[8];\nuniform sampler2D uApt;\nuniform float uEmitScale;\nuniform vec3 uShadeInside;\n')
      .replace('#include <lights_pars_begin>', pars)
      .replace('#include <map_fragment>', /* glsl */`
        #ifdef USE_MAP
          vec2 pUv = vMapUv;
          float row = floor(vColor.a * 8.0 + 0.5);
          if (row >= 1.0 && row <= 7.0) pUv.x += uPage[int(row) - 1];
          diffuseColor *= texture2D(map, pUv);
        #endif`)
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vColor.rgb;')
      .replace('#include <lights_lambert_fragment>', /* glsl */`
        vec3 toonBase = diffuseColor.rgb;
        LambertMaterial material;
        material.diffuseColor = vec3(1.0);
        material.specularStrength = 1.0;`)
      .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', /* glsl */`
        vec3 Lc = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
        float lum = dot(Lc, vec3(0.2126, 0.7152, 0.0722));
        vec3 band = lum < uThresh.x ? uBand0 : (lum < uThresh.y ? uBand1 : (lum < uThresh.z ? uBand2 : uBand3));
        vec3 hue = clamp(mix(vec3(1.0), Lc / max(lum, 0.002), uHueKeep), 0.0, 1.0);
        vec3 emission = vEmit.rgb;
        #if defined(TOON_SHADE)
          emission = (gl_FrontFacing ? vEmit.rgb : uShadeInside) * uEmitScale;
        #elif defined(TOON_LIP)
          emission = vEmit.rgb * uEmitScale;
        #else
          if (vEmit.w > 0.5) emission *= texelFetch(uApt, ivec2(int(vEmit.w + 0.5) - 1, 0), 0).r;
        #endif
        vec3 outgoingLight = hsvSat(toonBase, uSat) * band * hue + emission;
        outgoingLight = applyHaze(outgoingLight, vWPos);
        if (uDebugL > 0.0) outgoingLight = vec3(lum * uDebugL);   // light check against Blender`);
  };
  if (kind === 'shade') m.defines = { TOON_SHADE: '' };
  if (kind === 'lip') m.defines = { TOON_LIP: '' };
  m.customProgramCacheKey = () => 'aster-toon-' + kind;
  return m;
}

function unlitMaterial(U, opts) {
  // Flat colour or picture with haze; used for the screen, phone, window glass and glint.
  const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, ...opts });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_COMMON)
      .replace('#include <opaque_fragment>', 'outgoingLight = applyHaze(outgoingLight, vWPos);\n#include <opaque_fragment>');
  };
  m.customProgramCacheKey = () => 'aster-unlit';
  return m;
}

function skyMaterial(TL, U) {
  const stops = TL.sky.stops;
  const local = {
    uNight: { value: new THREE.Color() }, uPre: { value: 0 }, uMix: { value: 0 },
    uPredawn: { value: new THREE.Color().setRGB(...TL.sky.predawn) },
    uZ: { value: new THREE.Vector2(...TL.sky.z_range) },
    uStopPos: { value: stops.map((s) => s[0]) },
    uStopCol: { value: stops.map((s) => new THREE.Vector3(...s[1])) },
  };
  const n = stops.length;
  const m = new THREE.ShaderMaterial({
    uniforms: { ...U, ...local },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      varying vec3 vWPos;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWPos = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      ${GLSL_COMMON}
      uniform vec3 uNight; uniform float uPre; uniform float uMix; uniform vec3 uPredawn; uniform vec2 uZ;
      uniform float uStopPos[${n}]; uniform vec3 uStopCol[${n}];
      vec3 ramp(float t) {
        t = clamp(t, 0.0, 1.0);
        vec3 c = uStopCol[0];
        for (int i = 1; i < ${n}; i++) {
          float a = uStopPos[i - 1], b = uStopPos[i];
          if (t >= a) c = mix(uStopCol[i - 1], uStopCol[i], clamp((t - a) / max(b - a, 1e-5), 0.0, 1.0));
        }
        return c;
      }
      void main() {
        vec3 night = mix(uNight, uPredawn, uPre);
        vec3 hero = ramp((vWPos.y - uZ.x) / (uZ.y - uZ.x));
        vec3 c = mix(night, hero, uMix);
        gl_FragColor = vec4(applyHaze(c, vWPos), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  m.userData.uniforms = local;
  return m;
}

/* Clouds: each is the union of the ellipsoids build-story.py made it from, cut flat at its base.
   A box per cloud is rasterised and every pixel ray-casts the ellipsoids, so the outline is exact
   at any size. Colour: three-stop gradient on the height within the cloud (Generated Z). */
function buildClouds(TL, U) {
  const clouds = TL.clouds;
  const maxE = Math.max(...clouds.map((c) => c.ellipsoids.length));
  const tex = new Float32Array(maxE * 2 * clouds.length * 4);
  const pos = [], cid = [];
  clouds.forEach((c, ci) => {
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    c.ellipsoids.forEach(([x, y, z, rx, ry, rz], ei) => {
      // Blender (x, y, z) -> three (x, z, -y); radii follow.
      const o = (ci * maxE * 2 + ei * 2) * 4;
      tex.set([x, z, -y, 0, rx, rz, ry, 0], o);
      const cc = [x, Math.max(z, 0), -y], rr = [rx, rz, ry];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], cc[k] - rr[k]); hi[k] = Math.max(hi[k], cc[k] + rr[k]); }
    });
    lo[1] = Math.max(lo[1], 0);
    const L = c.k7_location, origin = [L[0], L[2], -L[1]];
    const box = new THREE.BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    box.translate((lo[0] + hi[0]) / 2 + origin[0], (lo[1] + hi[1]) / 2 + origin[1], (lo[2] + hi[2]) / 2 + origin[2]);
    const p = box.toNonIndexed().attributes.position.array;
    for (let i = 0; i < p.length; i++) pos.push(p[i]);
    for (let i = 0; i < p.length / 3; i++) cid.push(ci);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('cloudId', new THREE.Float32BufferAttribute(cid, 1));
  const dt = new THREE.DataTexture(tex, maxE * 2, clouds.length, THREE.RGBAFormat, THREE.FloatType);
  dt.needsUpdate = true;
  const info = clouds.map((c) => {
    const L = c.k7_location;
    return new THREE.Vector4(L[0], L[2], -L[1], c.ellipsoids.length);
  });
  const zr = clouds.map((c) => new THREE.Vector2(c.zmin, c.zmax));
  const local = {
    uEll: { value: dt }, uInfo: { value: info }, uZr: { value: zr }, uDrift: { value: 0 },
    uC0: { value: new THREE.Color() }, uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() },
    uR: { value: new THREE.Vector3(...TL.cloud_ramp) },
  };
  const m = new THREE.ShaderMaterial({
    uniforms: { ...U, ...local },
    side: THREE.BackSide,
    vertexShader: /* glsl */`
      attribute float cloudId; varying float vId; varying vec3 vWPos; uniform float uDrift;
      void main() { vId = cloudId; vec4 w = modelMatrix * vec4(position, 1.0); w.x += uDrift; vWPos = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      ${GLSL_COMMON}
      uniform mat4 projectionMatrix;
      uniform sampler2D uEll; uniform vec4 uInfo[${clouds.length}]; uniform vec2 uZr[${clouds.length}];
      uniform float uDrift; uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uR;
      varying float vId;
      void main() {
        int id = int(vId + 0.5);
        vec4 info = uInfo[id];
        vec3 origin = info.xyz + vec3(uDrift, 0.0, 0.0);
        vec3 ro = cameraPosition - origin;
        vec3 rd = normalize(vWPos - cameraPosition);
        float best = 1e20;
        int n = int(info.w + 0.5);
        for (int i = 0; i < ${maxE}; i++) {
          if (i >= n) break;
          vec4 a = texelFetch(uEll, ivec2(i * 2, id), 0);
          vec4 r = texelFetch(uEll, ivec2(i * 2 + 1, id), 0);
          vec3 o = (ro - a.xyz) / r.xyz, d = rd / r.xyz;
          float A = dot(d, d), B = dot(o, d), Cc = dot(o, o) - 1.0;
          float disc = B * B - A * Cc;
          if (disc < 0.0) continue;
          float sq = sqrt(disc);
          float t0 = (-B - sq) / A, t1 = (-B + sq) / A;
          // flat base: only y >= 0 (cloud-local)
          if (abs(rd.y) < 1e-6) { if (ro.y < 0.0) continue; }
          else {
            float tz = -ro.y / rd.y;
            if (rd.y > 0.0) t0 = max(t0, tz); else t1 = min(t1, tz);
          }
          if (t1 < max(t0, 0.0)) continue;
          float t = t0 > 0.0 ? t0 : 0.0;
          best = min(best, t);
        }
        if (best > 1e19) discard;
        vec3 hit = ro + rd * best;
        vec2 zr = uZr[id];
        float h = clamp((hit.y - zr.x) / max(zr.y - zr.x, 1e-4), 0.0, 1.0);
        vec3 c = h < uR.y ? mix(uC0, uC1, h / uR.y) : mix(uC1, uC2, (h - uR.y) / (uR.z - uR.y));
        vec3 wp = hit + origin;
        vec4 clip = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
        gl_FragColor = vec4(applyHaze(c, wp), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.frustumCulled = false;
  mesh.userData.uniforms = local;
  return mesh;
}

/* ---------------------------------------------------------------- screen and phone (2D canvases) */
function loadImage(url) {
  return new Promise((res, rej) => { const im = new Image(); im.decoding = 'async'; im.onload = () => res(im); im.onerror = rej; im.src = url; });
}

/* Which artwork a screen / phone state needs, and the first frame each file is needed at, from the
   step channel (frame -> state index). prefetch(f) loads everything needed up to frame f. */
function firstNeeded(steps, filesFor) {
  const first = {};
  for (const [frame, idx] of steps) for (const f of filesFor(idx)) if (!(f in first)) first[f] = frame;
  return first;
}

function makeScreen(def, base, onChange, steps) {
  const cv = document.createElement('canvas');
  cv.width = def.size[0]; cv.height = def.size[1];
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.anisotropy = 8;
  const imgs = {};
  const shadows = {};
  const requested = new Set();
  let state = null;
  const filesFor = (idx) => {
    const st = def.states[idx] || ['desktop', 0];
    const n = st[0] === 'desktop' ? 0 : st[0] === 'warning' ? def.windows.length : st[0] + 1;
    return [def.desktop, ...def.windows.slice(0, n).map((w) => w.file), ...(st[0] === 'warning' ? [def.warning.file] : [])];
  };
  const first = firstNeeded(steps, filesFor);
  function request(f) {
    if (requested.has(f)) return;
    requested.add(f);
    loadImage(new URL(f, base)).then((im) => {
      imgs[f] = im;
      if (state != null && filesFor(state).includes(f)) { const s2 = state; state = null; draw(s2); onChange(); }
    });
  }
  function prefetch(frame) { for (const [f, fr] of Object.entries(first)) if (fr <= frame) request(f); }
  function shadowFor(file, w, h) {
    const key = file + w + 'x' + h;
    if (shadows[key]) return shadows[key];
    const im = imgs[file]; if (!im) return null;
    const pad = 48, sc = document.createElement('canvas');
    sc.width = Math.ceil(w + pad * 2); sc.height = Math.ceil(h + pad * 2);
    const c = sc.getContext('2d');
    c.filter = `blur(${def.shadow.blur}px)`;
    c.drawImage(im, pad, pad, w, h);
    c.filter = 'none';
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = '#000'; c.fillRect(0, 0, sc.width, sc.height);
    shadows[key] = { canvas: sc, pad };
    return shadows[key];
  }
  function place(file, cx, cy, w, h, scale, alpha) {
    const im = imgs[file]; if (!im) return;
    const ww = w * scale, hh = h * scale;
    const x = cx - ww / 2, y = cy - hh / 2;
    const s = shadowFor(file, w, h);
    if (s) {
      ctx.globalAlpha = def.shadow.opacity * alpha;
      ctx.drawImage(s.canvas, x - s.pad * scale, y - s.pad * scale + def.shadow.dy, s.canvas.width * scale, s.canvas.height * scale);
    }
    ctx.globalAlpha = alpha;
    ctx.drawImage(im, x, y, ww, hh);
    ctx.globalAlpha = 1;
  }
  function draw(idx) {
    if (idx === state) return false;
    state = idx;
    filesFor(idx).forEach(request);   // in case the scroll outran the prefetch
    const st = def.states[idx] || ['desktop', 0];
    if (imgs[def.desktop]) ctx.drawImage(imgs[def.desktop], 0, 0, cv.width, cv.height);
    else { ctx.fillStyle = '#e8e4dc'; ctx.fillRect(0, 0, cv.width, cv.height); }
    const settled = st[0] === 'desktop' ? 0 : st[0] === 'warning' ? def.windows.length : st[0];
    for (let i = 0; i < settled; i++) { const w = def.windows[i]; place(w.file, w.cx, w.cy, w.w, w.h, 1, 1); }
    if (typeof st[0] === 'number') {
      const w = def.windows[st[0]], [sc, op] = def.pop[st[1]];
      place(w.file, w.cx, w.cy, w.w, w.h, sc, op);
    } else if (st[0] === 'warning') {
      const w = def.warning, [sc, op] = def.warn_pop[st[1]];
      place(w.file, w.cx, w.cy, w.w, w.h, sc, op);
    }
    tex.needsUpdate = true;
    return true;
  }
  return { texture: tex, draw, prefetch };
}

function makePhone(def, base, onChange, steps) {
  const cv = document.createElement('canvas');
  cv.width = def.size[0]; cv.height = def.size[1];
  const ctx = cv.getContext('2d');
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  const imgs = {};
  const requested = new Set();
  let state = null;
  const filesFor = (idx) => { const st = def.states[idx] || ['lock', 0]; return [def.lock, ...(typeof st[0] === 'number' ? [def.cards[st[0]].file] : [])]; };
  const first = firstNeeded(steps, filesFor);
  function request(f) {
    if (requested.has(f)) return;
    requested.add(f);
    loadImage(new URL(f, base)).then((im) => {
      imgs[f] = im;
      if (state != null && filesFor(state).includes(f)) { const s2 = state; state = null; draw(s2); onChange(); }
    });
  }
  function prefetch(frame) { for (const [f, fr] of Object.entries(first)) if (fr <= frame) request(f); }
  function draw(idx) {
    if (idx === state) return false;
    state = idx;
    filesFor(idx).forEach(request);
    const st = def.states[idx] || ['lock', 0];
    if (imgs[def.lock]) ctx.drawImage(imgs[def.lock], 0, 0, cv.width, cv.height);
    else { ctx.fillStyle = '#20263a'; ctx.fillRect(0, 0, cv.width, cv.height); }
    if (typeof st[0] === 'number') {
      const c = def.cards[st[0]], im = imgs[c.file];
      if (im) { ctx.globalAlpha = st[1]; ctx.drawImage(im, c.x, c.y, c.w, c.h); ctx.globalAlpha = 1; }
    }
    tex.needsUpdate = true;
    return true;
  }
  return { texture: tex, draw, prefetch };
}

/* ---------------------------------------------------------------- the room */
/* Portrait framing. export-web.py derives a portrait camera track from the landscape one (see
   PORTRAIT_KEYS there) and the page plays it when the viewport is taller than wide. For tuning,
   window.__portraitKeys = [[frame, back, lift, pitch, hfov], ...] re-derives it here at run time
   with the same maths. */
function portraitParams(keys, n = 451, sigma = 6) {
  const raw = [];
  for (let f = 1; f <= n; f++) {
    let k = 0; while (k < keys.length - 2 && keys[k + 1][0] <= f) k++;
    const [fa, ...a] = keys[k], [fb, ...b] = keys[k + 1];
    const t = Math.min(Math.max((f - fa) / (fb - fa), 0), 1);
    raw.push(a.map((v, i) => v + (b[i] - v) * t));
  }
  const r = Math.ceil(sigma * 3), out = [];
  for (let i = 0; i < n; i++) {
    const acc = [0, 0, 0, 0]; let w = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) { const g = Math.exp(-0.5 * ((j - i) / sigma) ** 2); w += g; for (let c = 0; c < 4; c++) acc[c] += raw[j][c] * g; }
    out.push(acc.map((v) => v / w));
  }
  return out;
}

/* Window opening, Blender coordinates (build-story.py / the walls): the outer face of the wall and
   the inner face of the jambs, plus the closed casements' frame bars. Used to give the two lights
   outside the window a window-shaped light map when their shadow maps are switched off. */
const WINDOW = {
  outer: { y: 3.08, x: [-2.85, 3.40], z: [2.90, 7.35] },
  inner: { y: 2.31, x: [-2.71, 3.31], z: [3.04, 7.31] },
  bars: { y: 3.03, rects: [   // [x0, x1, z0, z1]
    [-2.67, -2.56, 3.06, 7.29], [0.187, 0.413, 3.06, 7.29], [3.16, 3.27, 3.06, 7.29],   // stiles
    [-2.67, 3.27, 3.06, 3.20], [-2.67, 3.27, 7.18, 7.29], [-2.67, 3.27, 5.42, 5.48]] }, // rails, glazing bar
};

/* Shadow quality. 'high': every light that casts in Blender casts here (5 shadow maps).
   'low': the two area lights outside the window lose their shadow maps; a window-shaped light map
   keeps their light coming in through the opening only. Auto picks 'low' on touch-only devices,
   devices reporting 4 GB of memory or less, and GPUs known to be slow. ?shadows=low|high forces. */
function chooseShadowTier(renderer, requested) {
  if (requested === 'low' || requested === 'high') return requested;
  const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  const mem = navigator.deviceMemory;
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { /* unknown GPU: decide on the other signals */ }
  const slowGpu = /SwiftShader|llvmpipe|Software|Mali|Adreno|PowerVR|Intel\(R\) (U)?HD Graphics/i.test(gpu);
  return touchOnly || (mem && mem <= 4) || slowGpu ? 'low' : 'high';
}

function windowLightMap(L) {
  // Project the opening through the light's (map) camera: inside = white, frame bars and wall = black.
  L.shadow.updateMatrices(L);
  const cam = L.shadow.camera;
  const N = 1024, cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d');
  const toPx = (x, y, z) => {
    const p = new THREE.Vector3(x, z, -y).project(cam);      // Blender -> three, then NDC
    return [(p.x * 0.5 + 0.5) * N, (1 - (p.y * 0.5 + 0.5)) * N];
  };
  const quad = (r, x0, x1, z0, z1) => {
    const pts = [toPx(x0, r, z0), toPx(x1, r, z0), toPx(x1, r, z1), toPx(x0, r, z1)];
    ctx.beginPath(); ctx.moveTo(...pts[0]); for (let i = 1; i < 4; i++) ctx.lineTo(...pts[i]); ctx.closePath(); ctx.fill();
  };
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, N, N);
  ctx.fillStyle = '#fff';
  const o = WINDOW.outer, n = WINDOW.inner;
  quad(o.y, o.x[0], o.x[1], o.z[0], o.z[1]);
  ctx.globalCompositeOperation = 'destination-in';        // light must pass both faces of the wall
  quad(n.y, n.x[0], n.x[1], n.z[0], n.z[1]);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  for (const r of WINDOW.bars.rects) quad(WINDOW.bars.y, ...r);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

export async function createRoom(canvas, { onProgress, shadows = 'auto' } = {}) {
  const [TL, gltf] = await Promise.all([
    fetch(new URL('story-timeline.json', DATA)).then((r) => r.json()),
    new Promise((res, rej) => {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.load(new URL('study-room.glb', DATA).href, res, (e) => onProgress && e.total && onProgress(e.loaded / e.total), rej);
    }),
  ]);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setClearColor(0x000000, 1);

  const scene = new THREE.Scene();
  const U = makeUniforms(TL);
  const aptTex = new THREE.DataTexture(new Float32Array(TL.apartment_lights.length), TL.apartment_lights.length, 1, THREE.RedFormat, THREE.FloatType);
  aptTex.needsUpdate = true;
  U.uApt.value = aptTex;

  // Materials by class (names written by export-web.py).
  const atlas = (() => { let t = null; gltf.scene.traverse((o) => { if (o.isMesh && o.material.map && !t) t = o.material.map; }); return t; })();
  if (atlas) { atlas.anisotropy = 4; }
  let redraw = () => {};
  const screen = makeScreen(TL.screen, DATA, () => redraw(), TL.channels.screen);
  const phone = makePhone(TL.phone, DATA, () => redraw(), TL.channels.phone);
  const PREFETCH_START = 46;     // first screen: what K0-K1 shows
  screen.prefetch(PREFETCH_START); phone.prefetch(PREFETCH_START);
  const MATS = {
    toon: toonMaterial('toon', atlas, U),
    shade: toonMaterial('shade', atlas, U),
    lip: toonMaterial('lip', atlas, U),
    glass: toonMaterial('glass', atlas, U, { transparent: true, opacity: TL.glass.lens_alpha, depthWrite: false }),
    wglass: unlitMaterial(U, { color: new THREE.Color(), transparent: true, opacity: TL.glass.alpha, depthWrite: false }),
    glint: unlitMaterial(U, { color: new THREE.Color(), transparent: true, opacity: TL.glass.glint_alpha, depthWrite: false }),
    screen: unlitMaterial(U, { map: screen.texture, color: new THREE.Color(0.8, 0.8, 0.8) }),
    phone: unlitMaterial(U, { map: phone.texture, color: new THREE.Color(0.9, 0.9, 0.9) }),
    sky: skyMaterial(TL, U),
  };

  const byNode = {};
  const layoutNodes = [];
  gltf.scene.traverse((o) => {
    const ex = o.userData || {};
    if (ex.node) {
      byNode[ex.node] = o;
      if (ex.layout) layoutNodes.push({ obj: o, rows: TL.layout[ex.layout], carried: !!ex.carried_by });
    }
  });
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    let p = o, cast = true;
    while (p) { if (p.userData && 'castShadow' in p.userData) { cast = p.userData.castShadow; break; } p = p.parent; }
    const mat = MATS[o.material.name] || MATS.toon;
    o.material = mat;
    const kind = o.material === MATS.glass || o.material === MATS.wglass || o.material === MATS.glint;
    o.castShadow = cast && !kind && o.material !== MATS.screen && o.material !== MATS.phone && o.material !== MATS.sky;
    o.receiveShadow = !kind && o.material !== MATS.sky;
    if (kind) o.renderOrder = 2;
  });
  scene.add(gltf.scene);
  // The sky backdrop was sized for the 16:9 frame; a portrait frame looking up at K7 sees past its
  // top edge. Stretch it upward (the gradient is by world height, so the colours do not change).
  if (byNode.sky) { byNode.sky.scale.y *= 4; }
  const clouds = buildClouds(TL, U);
  scene.add(clouds);

  // The animation drives the glTF camera; pictures are taken with a second camera that copies it
  // each frame (the mixer only writes values that changed, so the animated one must stay untouched).
  const animCam = gltf.cameras[0];
  const hfov = animCam.userData.hfov || 2 * Math.atan(18 / 35);
  const camera = new THREE.PerspectiveCamera(animCam.fov, 16 / 9, animCam.near, animCam.far);

  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clipEnd = Math.min(...gltf.animations.map((c) => c.duration)) - 1e-5;
  gltf.animations.forEach((clip) => mixer.clipAction(clip).play());

  /* lights */
  const lights = [];
  const shadowTier = chooseShadowTier(renderer, shadows);
  // The room as the shadow maps must cover it: the static interior's bounds (three.js coords).
  const ROOM = new THREE.Box3();
  if (byNode.static_interior) { byNode.static_interior.updateMatrixWorld(true); ROOM.setFromObject(byNode.static_interior); }
  else ROOM.set(new THREE.Vector3(-4.6, 0, -3.6), new THREE.Vector3(4.6, 8.6, 5.5));
  ROOM.expandByScalar(0.2);
  TL.lights.forEach((d) => {
    let L;
    const pos = new THREE.Vector3(...d.position), dir = new THREE.Vector3(...d.direction);
    if (d.type === 'sun') {
      L = new THREE.DirectionalLight(0xffffff, 1);
      L.castShadow = true;
      L.shadow.mapSize.set(2048, 2048);
      L.shadow.bias = -0.0003;
      L.shadow.normalBias = 0.004;
    } else if (d.type === 'area' || d.type === 'spot') {
      // EEVEE ignores an area light's spread (measured: 1.45 rad and 180 deg render the same), so
      // every area light is a plain Lambertian emitter over the whole front hemisphere.
      const half = Math.PI / 2 - 0.001;
      L = new THREE.SpotLight(0xffffff, 1, 0, half, half < 1.4 ? 0.04 : 0.02, 2);
      L.position.copy(pos);
      L.target.position.copy(pos.clone().add(dir));
      L.castShadow = d.shadow;
      L.shadow.mapSize.set(2048, 2048);
      L.shadow.camera.near = 0.05; L.shadow.camera.far = 80;
      // Shadow frustum: just wide enough to cover the room as seen from the light.
      let need = 0;
      for (let i = 0; i < 8; i++) {
        const c = new THREE.Vector3(i & 1 ? ROOM.max.x : ROOM.min.x, i & 2 ? ROOM.max.y : ROOM.min.y, i & 4 ? ROOM.max.z : ROOM.min.z);
        need = Math.max(need, c.sub(pos).angleTo(dir));
      }
      L.shadow.focus = Math.min(need * 1.05, half, THREE.MathUtils.degToRad(84)) / half;
      L.shadow.bias = -0.0003;
      L.shadow.normalBias = 0.003;    // larger values leak light under thin parts (laptop lid, books)
      scene.add(L.target);
      const outside = pos.z < -3.1;   // three z = -Blender y: beyond the window wall
      if (shadowTier === 'low' && outside) {
        // No shadow map: the cone shrinks to the map's frustum (nothing outside it is lit) and a
        // window-shaped light map lets the light in through the opening only.
        L.castShadow = false;
        L.angle = Math.min(need * 1.05, THREE.MathUtils.degToRad(84));
        L.shadow.focus = 1;
        L.updateMatrixWorld(); L.target.updateMatrixWorld();
        L.map = windowLightMap(L);
      }
    } else {
      L = new THREE.PointLight(0xffffff, 1, 0, 2);
      L.position.copy(pos);
    }
    L.intensity = 1;
    scene.add(L);
    if (L.target && !L.target.parent) scene.add(L.target);
    lights.push({ def: d, light: L, color: linear(TL.channels['light:' + d.name]),
      unit: d.type === 'sun' ? 0 : d.type === 'point' ? 1 / (4 * Math.PI) : 1 / Math.PI,   // channel = energy x unit
      sundir: TL.channels['sundir:' + d.name] ? linear(TL.channels['sundir:' + d.name]) : null });
  });
  const ambient = new THREE.AmbientLight(0xffffff, 1);
  scene.add(ambient);

  /* channels */
  const CH = TL.channels;
  const ch = {};
  for (const [k, v] of Object.entries(CH)) {
    if (k === 'apt') continue;
    ch[k] = (k === 'screen' || k === 'phone' || k.startsWith('page:') || k.startsWith('vis:')) ? step(v) : linear(v);
  }
  const apt = CH.apt.map((pts) => step(pts));
  const pageInfo = Object.values(TL.pages);
  const visNodes = Object.keys(CH).filter((k) => k.startsWith('vis:')).map((k) => ({ obj: byNode[k.slice(4)], f: ch[k] })).filter((v) => v.obj);
  const hazeColor = new THREE.Color().setRGB(...TL.haze.color);
  const tmp = new THREE.Vector3(), center = new THREE.Vector3();
  ROOM.getCenter(center);

  let lastScreen = -1, lastPhone = -1;
  const aptData = aptTex.image.data;

  function setFrame(f) {
    f = Math.min(Math.max(f, TL.frames[0]), TL.frames[1]);
    mixer.setTime(Math.min((f - TL.frames[0]) / TL.fps, clipEnd));   // never wrap past the last key
    camera.position.copy(animCam.position);
    camera.quaternion.copy(animCam.quaternion);
    const b = ch.bands(f);
    U.uBand0.value.set(b[0], b[1], b[2]); U.uBand1.value.set(b[3], b[4], b[5]);
    U.uBand2.value.set(b[6], b[7], b[8]); U.uBand3.value.set(b[9], b[10], b[11]);
    for (const l of lights) {
      const c = l.color(f);
      l.light.color.setRGB(c[0], c[1], c[2]);
      const on = c[0] + c[1] + c[2] > 1e-4;
      l.light.visible = on;
      if (l.unit) {
        // EEVEE's influence radius: the light fades to nothing at sqrt(max(colour) * energy / 100 /
        // light threshold), with the same (1 - (d/R)^4)^2 curve three.js uses for light.distance.
        const power = Math.max(c[0], c[1], c[2]) / l.unit;
        l.light.distance = Math.sqrt(power / 100 / LIGHT_THRESHOLD);
      }
      if (l.sundir) {
        const d = l.sundir(f);
        tmp.set(d[0], d[1], d[2]).normalize();
        l.light.target.position.copy(center);
        l.light.position.copy(center).addScaledVector(tmp, -SUN_REACH);
        fitSunShadow(l.light, tmp);
      }
    }
    const a = ch.ambient(f);
    ambient.color.setRGB(a[0], a[1], a[2]);
    // sky and clouds
    const sm = MATS.sky.userData.uniforms;
    const n = ch.sky_night(f); sm.uNight.value.setRGB(n[0], n[1], n[2]);
    sm.uPre.value = ch.sky_pre(f); sm.uMix.value = ch.sky_mix(f);
    const cu = clouds.userData.uniforms, cc = ch.cloud(f);
    cu.uC0.value.setRGB(cc[0], cc[1], cc[2]); cu.uC1.value.setRGB(cc[3], cc[4], cc[5]); cu.uC2.value.setRGB(cc[6], cc[7], cc[8]);
    cu.uDrift.value = ch.cloud_dx(f);
    // glass, haze, lamp shade
    const g = ch.glass(f), gl = ch.glint(f), tint = TL.glass.tint;
    MATS.wglass.color.setRGB(tint[0] * g, tint[1] * g, tint[2] * g);
    MATS.glint.color.setRGB(gl, gl, gl);
    U.uHazeDensity.value = ch.haze(f) * HAZE_K;
    U.uHazeColor.value.copy(hazeColor).multiply(ambient.color).multiplyScalar(HAZE_COLOR_K);
    MATS.shade.userData.uniforms.uEmitScale.value = ch.shade(f);
    MATS.lip.userData.uniforms.uEmitScale.value = ch.lip(f);
    // pages
    for (const p of pageInfo) {
      const k = ch['page:' + Object.keys(TL.pages).find((n2) => TL.pages[n2] === p)];
      const ver = k ? Math.min(k(f), p.x.length - 1) : 0;
      U.uPage.value[p.row - 1] = (p.x[ver] - p.x[0]) / p.atlas[0];
    }
    // apartment windows
    let changed = false;
    for (let i = 0; i < apt.length; i++) { const v = apt[i](f); if (aptData[i] !== v) { aptData[i] = v; changed = true; } }
    if (changed) aptTex.needsUpdate = true;
    // screen and phone
    const si = ch.screen(f); if (si !== lastScreen) { screen.draw(si); lastScreen = si; }
    const pi = ch.phone(f); if (pi !== lastPhone) { phone.draw(pi); lastPhone = pi; }
    // visibility and desk layout
    for (const v of visNodes) v.obj.visible = !!v.f(f);
    const fi = Math.floor(f + 1e-4);
    for (const n2 of layoutNodes) {
      const rows = n2.rows;
      let r = rows[0];
      for (let i = 1; i < rows.length && rows[i].frame <= fi; i++) r = rows[i];
      if (!n2.carried) {
        n2.obj.position.set(r.x, r.z, -r.y);
        n2.obj.rotation.set(0, r.rot_z, 0);
      }
      n2.obj.visible = r.visible;
    }
    // Once the camera is out of the window the room's shadows are behind it (and the sun patch is
    // off at dawn): keep the last shadow maps instead of re-rendering five of them every frame.
    renderer.shadowMap.autoUpdate = f < 342;
    if (portrait) applyPortrait(f);
    // Opening (home page hero): a small lens shift lifts the room so the desk clears the headline
    // and pills along the bottom; it eases back to the shot's own framing as the copy fades.
    if (opening > 0.001) {
      const sx = 0, sy = portrait ? OPENING_SHIFT.portrait : OPENING_SHIFT.landscape;
      camera.setViewOffset(width, height, sx * width * opening, sy * height * opening, width, height);
    } else if (camera.view && camera.view.enabled) camera.clearViewOffset();
    // Depth precision: the near plane follows the distance to the nearest surface (from the export),
    // so the far houses' layered windows (1 cm apart, 60-120 units out) do not fight.
    const near = NEAR_FORCE || (ch.near ? ch.near(f) : (f < 336 ? 0.02 : 0.25));
    if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
  }

  // Fraction of the frame height the opening moves the view down (the room up). Debug: ?shift=0.1
  const SHIFT_Q = parseFloat(new URLSearchParams(location.search).get('shift'));
  const OPENING_SHIFT = Number.isFinite(SHIFT_Q) ? { landscape: SHIFT_Q, portrait: SHIFT_Q } : { landscape: 0.1, portrait: 0.16 };
  const NEAR_FORCE = parseFloat(new URLSearchParams(location.search).get('near')) || 0;   // debug
  const HAZE_K = 1.0, HAZE_COLOR_K = 1.0 / Math.PI;
  const LIGHT_THRESHOLD = TL.light_threshold || 0.01;   // scene.eevee.light_threshold
  const SUN_REACH = 220;   // houses are up to ~130 units out
  const lightView = new THREE.Matrix4();
  const corners = [];
  for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? ROOM.max.x : ROOM.min.x, i & 2 ? ROOM.max.y : ROOM.min.y, i & 4 ? ROOM.max.z : ROOM.min.z));
  function fitSunShadow(L, dir) {
    L.updateMatrixWorld();
    L.target.updateMatrixWorld();
    lightView.lookAt(L.position, L.target.position, new THREE.Vector3(0, 1, 0)).setPosition(L.position);
    const inv = lightView.clone().invert();
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const c of corners) {
      tmp.copy(c).applyMatrix4(inv);
      x0 = Math.min(x0, tmp.x); x1 = Math.max(x1, tmp.x); y0 = Math.min(y0, tmp.y); y1 = Math.max(y1, tmp.y);
      z0 = Math.min(z0, -tmp.z); z1 = Math.max(z1, -tmp.z);
    }
    // The light sits SUN_REACH out, so everything between it and the room (the houses across the
    // street) falls inside the depth range and can shade the window.
    const cam = L.shadow.camera;
    cam.left = x0; cam.right = x1; cam.bottom = y0; cam.top = y1; cam.near = 1; cam.far = z1 + 1;
    cam.updateProjectionMatrix();
  }

  let portrait = false, pParams = null, pKeys = null, opening = 0;
  const PT = TL.portrait;
  const ptPos = PT && linear(PT.position), ptQuat = PT && linear(PT.quaternion), ptH = PT && linear(PT.hfov);
  const _d = new THREE.Vector3(), _p = new THREE.Vector3();
  function applyPortrait(f) {
    let H;
    if (window.__portraitKeys) {                      // tuning: derive at run time
      if (pKeys !== window.__portraitKeys) { pKeys = window.__portraitKeys; pParams = portraitParams(pKeys); }
      const i = Math.min(Math.max(f - 1, 0), pParams.length - 1), i0 = Math.floor(i), i1 = Math.min(i0 + 1, pParams.length - 1), t = i - i0;
      const [b, l, pitch, h] = pParams[i0].map((v, c) => v + (pParams[i1][c] - v) * t);
      _d.set(0, 0, -1).applyQuaternion(camera.quaternion);
      const e = Math.asin(Math.min(Math.max(_d.y, -1), 1)) + THREE.MathUtils.degToRad(pitch);
      const hl = Math.hypot(_d.x, _d.z) || 1;
      _p.copy(camera.position).addScaledVector(_d, -b); _p.y += l;
      camera.position.copy(_p);
      _d.set(_d.x / hl * Math.cos(e), Math.sin(e), _d.z / hl * Math.cos(e));
      camera.up.set(0, 1, 0);
      camera.lookAt(_p.add(_d));
      H = h;
    } else if (PT) {
      const p = ptPos(f), q = ptQuat(f);
      camera.position.set(p[0], p[1], p[2]);
      camera.quaternion.set(q[0], q[1], q[2], q[3]).normalize();
      H = ptH(f);
    } else return;
    const th = Math.tan(THREE.MathUtils.degToRad(H) / 2);
    const vfov = 2 * Math.atan(th / camera.aspect);      // portrait keeps the horizontal angle
    camera.fov = THREE.MathUtils.radToDeg(vfov);
    camera.updateProjectionMatrix();
  }

  let width = 0, height = 0;
  function resize(w, h, dpr) {
    width = w; height = h;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    const aspect = w / h;
    camera.aspect = aspect;
    // The shot is framed for 16:9 with a fixed horizontal angle (sensor fit horizontal).
    // Narrower screens keep the 16:9 vertical angle down to 4:3, then widen it gently.
    const vfov169 = 2 * Math.atan(Math.tan(hfov / 2) / (16 / 9));
    let vfov = 2 * Math.atan(Math.tan(hfov / 2) / aspect);
    if (aspect < 4 / 3) vfov = Math.min(vfov, 2 * Math.atan(Math.tan(vfov169 / 2) * 1.35));
    camera.fov = THREE.MathUtils.radToDeg(vfov);
    camera.updateProjectionMatrix();
    portrait = aspect < 1 || new URLSearchParams(location.search).has('portrait');
  }
  function render() { renderer.render(scene, camera); }
  redraw = () => room.onNeedsRender && room.onNeedsRender();

  const room = {
    setFrame, render, resize, renderer, scene, camera, timeline: TL, uniforms: U, THREE, lights, ambient,
    info() { return renderer.info; },
    setOpening(t) { opening = Math.min(Math.max(t, 0), 1); },
    prefetch(f) { screen.prefetch(f); phone.prefetch(f); },
    shadowTier,
    dispose() { renderer.dispose(); },
    onNeedsRender: null,
  };
  return room;
}
