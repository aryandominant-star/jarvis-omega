import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Device } from "../../../../packages/shared-types/src/index";

export type CoreState = "idle" | "listening" | "thinking" | "executing" | "speaking" | "error" | "offline";

type Pal = { core: string; accent: string; speed: number; energy: number };

const PALETTE: Record<CoreState, Pal> = {
  idle: { core: "#aef4ff", accent: "#4f7bff", speed: 0.2, energy: 1.05 },
  listening: { core: "#ccfbff", accent: "#00e5ff", speed: 0.45, energy: 1.3 },
  thinking: { core: "#8fe0ff", accent: "#8b5cf6", speed: 1.0, energy: 1.4 },
  executing: { core: "#5cf2ff", accent: "#00b3ff", speed: 1.6, energy: 1.65 },
  speaking: { core: "#e6feff", accent: "#22d3ee", speed: 0.6, energy: 1.5 },
  error: { core: "#ffb547", accent: "#ff6b3d", speed: 0.25, energy: 1.05 },
  offline: { core: "#3a5470", accent: "#1d2b40", speed: 0.05, energy: 0.35 },
};

// Serious mode: the whole core burns red. Faster, hotter, more urgent.
const SERIOUS: Record<CoreState, Pal> = {
  idle: { core: "#ff5a52", accent: "#b1121f", speed: 0.5, energy: 1.35 },
  listening: { core: "#ff8a7a", accent: "#ff2a2a", speed: 0.7, energy: 1.5 },
  thinking: { core: "#ff6b5a", accent: "#ff1744", speed: 1.3, energy: 1.6 },
  executing: { core: "#ff4d4d", accent: "#ff0033", speed: 2.0, energy: 1.9 },
  speaking: { core: "#ffb0a0", accent: "#ff3b30", speed: 0.85, energy: 1.65 },
  error: { core: "#ffd23d", accent: "#ff3b1f", speed: 0.4, energy: 1.2 },
  offline: { core: "#5a2b2b", accent: "#2a0d0d", speed: 0.05, energy: 0.4 },
};

const pal = (state: CoreState, serious: boolean): Pal => (serious ? SERIOUS : PALETTE)[state];

// ---------- shared GLSL ----------
const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1./289.))*289.;}vec4 mod289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 permute(vec4 x){return mod289(((x*34.)+1.)*x);}vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
i=mod289(i);vec4 p=permute(permute(permute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
float fbm(vec3 p){float f=0.,a=.5;for(int i=0;i<3;i++){f+=a*snoise(p);p*=2.02;a*=.5;}return f;}
`;

// ---------- nebula sky ----------
function Nebula({ serious }: { serious: boolean }) {
  const mat = useMemo(() => new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uSerious: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: NOISE + /* glsl */ `
      uniform float uTime; uniform float uSerious; varying vec3 vDir;
      void main(){
        vec3 d = vDir; float t = uTime*0.006;
        float n1 = fbm(d*2.2 + vec3(t,0.,-t));
        float n2 = fbm(d*4.5 - vec3(0.,t*1.5,t));
        float band = exp(-pow(d.y*2.6 + n1*0.6, 2.0));
        vec3 deep   = mix(vec3(0.008,0.012,0.03), vec3(0.05,0.004,0.006), uSerious);
        vec3 violet = mix(vec3(0.16,0.06,0.34),  vec3(0.42,0.03,0.05),  uSerious);
        vec3 cyan   = mix(vec3(0.0,0.42,0.55),   vec3(0.6,0.07,0.05),   uSerious);
        vec3 spark  = mix(vec3(0.9,0.5,0.95),    vec3(1.0,0.35,0.25),   uSerious);
        vec3 col = deep;
        col += violet * smoothstep(0.0,0.9,n1+0.35) * 0.55;
        col += cyan * smoothstep(0.15,1.0,n2+band*0.6) * band * 0.55;
        col += spark * pow(max(n2,0.0),5.0) * 0.25;
        gl_FragColor = vec4(col,1.);
      }`,
  }), []);
  useFrame((_, dt) => {
    mat.uniforms.uTime.value += dt;
    const u = mat.uniforms.uSerious;
    u.value += ((serious ? 1 : 0) - u.value) * Math.min(1, dt * 1.5);
  });
  return <mesh material={mat}><sphereGeometry args={[80, 32, 32]} /></mesh>;
}

function Stars() {
  const geo = useMemo(() => {
    const n = 1500, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = 18 + Math.random() * 55, t = Math.random() * Math.PI * 2, p = Math.acos(2 * Math.random() - 1);
      pos.set([r * Math.sin(p) * Math.cos(t), r * Math.cos(p), r * Math.sin(p) * Math.sin(t)], i * 3);
      const warm = Math.random() < 0.15;
      col.set(warm ? [1, 0.82, 0.7] : [0.65 + Math.random() * 0.35, 0.85 + Math.random() * 0.15, 1], i * 3);
      size[i] = Math.random() < 0.04 ? 3.2 : 0.6 + Math.random() * 1.4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("size", new THREE.BufferAttribute(size, 1));
    return g;
  }, []);
  const mat = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `attribute float size; varying vec3 vC; varying float vTw; uniform float uTime;
      void main(){ vC = color; vTw = 0.65+0.35*sin(uTime*1.7+position.x*3.1+position.z);
      vec4 mv = modelViewMatrix*vec4(position,1.); gl_PointSize = size*(260./-mv.z); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vC; varying float vTw; void main(){ vec2 c=gl_PointCoord-.5; float d=length(c);
      float a = smoothstep(.5,0.,d); a = pow(a,2.2); gl_FragColor = vec4(vC*vTw, a); }`,
  }), []);
  const ref = useRef<THREE.Points>(null!);
  useFrame((_, dt) => { mat.uniforms.uTime.value += dt; ref.current.rotation.y += dt * 0.006; });
  return <points ref={ref} geometry={geo} material={mat} />;
}

// ---------- the core ----------
function glowTexture(inner: string, outer = "rgba(0,0,0,0)") {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d")!; const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, inner); grd.addColorStop(0.25, inner.replace(/[\d.]+\)$/, "0.35)")); grd.addColorStop(1, outer);
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

function Core({ state, level, serious }: { state: CoreState; level: React.MutableRefObject<number>; serious: boolean }) {
  const p = pal(state, serious);
  const plasma = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCol: { value: new THREE.Color(p.core) }, uAcc: { value: new THREE.Color(p.accent) }, uEnergy: { value: 1 } },
    vertexShader: `varying vec3 vN; varying vec3 vP; varying vec3 vV; void main(){ vN=normalize(normalMatrix*normal); vP=position;
      vec4 mv=modelViewMatrix*vec4(position,1.); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: NOISE + `uniform float uTime; uniform vec3 uCol; uniform vec3 uAcc; uniform float uEnergy; varying vec3 vN; varying vec3 vP; varying vec3 vV;
      void main(){ float n = fbm(vP*2.4 + vec3(0., uTime*0.25, uTime*0.15));
        float cells = smoothstep(0.1,0.7, fbm(vP*6. - uTime*0.3)*0.5+0.5);
        float fres = pow(1.-max(dot(vN,vV),0.),2.5);
        vec3 col = mix(uAcc*0.6, uCol, n*0.5+0.5) * (0.7+cells*0.8);
        col += uCol*fres*1.8; col += vec3(1.)*pow(cells,6.)*0.6;
        gl_FragColor = vec4(col*uEnergy, 1.); }`,
  }), []);
  const disk = useMemo(() => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uCol: { value: new THREE.Color(p.core) }, uAcc: { value: new THREE.Color(p.accent) }, uSpeed: { value: 0.2 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: NOISE + `uniform float uTime; uniform vec3 uCol; uniform vec3 uAcc; uniform float uSpeed; varying vec2 vUv;
      void main(){ vec2 c = vUv-.5; float r = length(c)*2.; float a = atan(c.y,c.x);
        if(r<0.42||r>1.) discard;
        float swirl = fbm(vec3(cos(a)*r*3., sin(a)*r*3., uTime*uSpeed) + vec3(r*4.-uTime*uSpeed*2.));
        float rings = 0.5+0.5*sin(r*90. + swirl*4.);
        float fall = smoothstep(1.,0.55,r)*smoothstep(0.42,0.5,r);
        vec3 col = mix(uAcc, uCol, smoothstep(0.9,0.45,r));
        gl_FragColor = vec4(col*(0.35+rings*0.5+swirl*0.6), fall*(0.45+swirl*0.35)); }`,
  }), []);
  const corona = useMemo(() => glowTexture("rgba(120,240,255,1)"), []);
  const flare = useMemo(() => glowTexture("rgba(255,255,255,0.9)"), []);
  const coreRef = useRef<THREE.Mesh>(null!);
  const coronaRef = useRef<THREE.Sprite>(null!);
  const ticks = useRef<THREE.Group>(null!);
  const target = useMemo(() => ({ core: new THREE.Color(), acc: new THREE.Color() }), []);

  useFrame(({ clock }, dt) => {
    const t = clock.getElapsedTime();
    target.core.set(p.core); target.acc.set(p.accent);
    for (const m of [plasma, disk]) {
      m.uniforms.uTime.value = t;
      (m.uniforms.uCol.value as THREE.Color).lerp(target.core, dt * 2);
      (m.uniforms.uAcc.value as THREE.Color).lerp(target.acc, dt * 2);
    }
    plasma.uniforms.uEnergy.value += (p.energy - plasma.uniforms.uEnergy.value) * dt * 2;
    disk.uniforms.uSpeed.value += (p.speed * 0.6 - disk.uniforms.uSpeed.value) * dt;
    const beat = 1 + Math.sin(t * (state === "thinking" ? 5 : 1.6)) * 0.025 + level.current * 0.3;
    coreRef.current.scale.setScalar(beat);
    coronaRef.current.scale.setScalar(4.2 * p.energy * (1 + level.current * 0.5 + Math.sin(t * 0.8) * 0.04));
    (coronaRef.current.material as THREE.SpriteMaterial).color.lerp(target.core, dt * 2);
    ticks.current.rotation.z -= dt * p.speed * 0.25;
  });

  const tickGeo = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i < 180; i++) {
      const a = (i / 180) * Math.PI * 2, r = 2.05, len = i % 15 === 0 ? 0.16 : i % 5 === 0 ? 0.08 : 0.035;
      pts.push(Math.cos(a) * r, Math.sin(a) * r, 0, Math.cos(a) * (r + len), Math.sin(a) * (r + len), 0);
    }
    return new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  }, []);

  return (
    <group>
      <sprite ref={coronaRef}><spriteMaterial map={corona} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.85} /></sprite>
      <sprite scale={[1.6, 1.6, 1]}><spriteMaterial map={flare} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={0.5} /></sprite>
      <mesh ref={coreRef} material={plasma}><icosahedronGeometry args={[0.72, 6]} /></mesh>
      <mesh rotation={[-Math.PI / 2.25, 0, 0.2]} material={disk}><planeGeometry args={[4.6, 4.6]} /></mesh>
      <group ref={ticks} rotation={[-Math.PI / 2.25, 0, 0.2]}>
        <lineSegments geometry={tickGeo}><lineBasicMaterial color={p.core} transparent opacity={0.45} /></lineSegments>
      </group>
    </group>
  );
}

// ---------- device planets ----------
function statusColor(d: Device) {
  if (!d.online) return "#41566e";
  const disk = d.metrics?.disks?.[0];
  if ((d.metrics?.cpuPercent ?? 0) > 90 || (disk && disk.usedBytes / disk.totalBytes > 0.92)) return "#ffb547";
  if (d.currentTasks > 0) return "#5cf2ff";
  return "#2fd5ff";
}

function makeLabel(name: string, color: string, line2: string, line3: string) {
  const c = document.createElement("canvas"); c.width = 640; c.height = 220;
  const g = c.getContext("2d")!;
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  g.strokeStyle = color; g.globalAlpha = 0.85; g.lineWidth = 3;
  g.beginPath(); g.moveTo(8, 200); g.lineTo(60, 120); g.lineTo(620, 120); g.stroke();
  g.globalAlpha = 1; g.shadowColor = color; g.shadowBlur = 16; g.fillStyle = "#e9fbff";
  g.font = "700 58px 'Rajdhani','Segoe UI',sans-serif"; g.fillText(name.toUpperCase().split("").join(" "), 70, 105);
  g.shadowBlur = 0; g.font = "500 30px 'JetBrains Mono','Consolas',monospace"; g.fillStyle = color; g.fillText(line2, 72, 162);
  g.fillStyle = "rgba(190,220,235,0.7)"; g.fillText(line3, 72, 202);
  const tex = new THREE.CanvasTexture(c); tex.anisotropy = 8;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  s.center.set(0, 0.1); s.scale.set(2.3, 0.79, 1); s.renderOrder = 10;
  return s;
}

function arcGeo(r: number, frac: number) {
  const pts: THREE.Vector3[] = [];
  const n = Math.max(2, Math.round(96 * frac));
  for (let i = 0; i <= n; i++) { const a = -Math.PI / 2 + (i / 96) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0)); }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

function Planet({ device, index, count, selected, onSelect, positions }: {
  device: Device; index: number; count: number; selected: boolean; onSelect: (id: string) => void; positions: React.MutableRefObject<Map<string, THREE.Vector3>>;
}) {
  const group = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Mesh>(null!);
  const hud = useRef<THREE.Group>(null!);
  const [hover, setHover] = useState(false);
  const color = statusColor(device);
  const cpu = Math.min(100, device.metrics?.cpuPercent ?? 0) / 100;
  const mem = device.metrics ? device.metrics.memUsedBytes / device.metrics.memTotalBytes : 0;
  const radius = 3.4 + (index % 3) * 1.15 + Math.floor(index / 3) * 0.5;
  const incl = (index % 2 ? 1 : -1) * (0.12 + (index % 3) * 0.05);
  const phase = (index / Math.max(count, 1)) * Math.PI * 2 + 0.6;
  const size = 0.3 + (device.metrics ? Math.min(device.metrics.memTotalBytes / 64e9, 1) * 0.12 : 0.04);
  const seed = useMemo(() => [...device.id].reduce((a, c) => a + c.charCodeAt(0), 0) % 97, [device.id]);

  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCol: { value: new THREE.Color(color) }, uSeed: { value: seed }, uAlive: { value: device.online ? 1 : 0.25 } },
    vertexShader: `varying vec3 vN; varying vec3 vP; varying vec3 vV; void main(){ vN=normalize(normalMatrix*normal); vP=position;
      vec4 mv=modelViewMatrix*vec4(position,1.); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: NOISE + `uniform float uTime; uniform vec3 uCol; uniform float uSeed; uniform float uAlive; varying vec3 vN; varying vec3 vP; varying vec3 vV;
      void main(){ vec3 p = vP*3.2 + uSeed;
        float land = fbm(p + vec3(uTime*0.02,0.,0.));
        float bands = sin(vP.y*18. + fbm(p*0.7)*3.);
        float lit = max(dot(vN, normalize(vec3(-0.6,0.3,0.7))), 0.);
        vec3 base = mix(vec3(0.02,0.05,0.1), uCol*0.45, smoothstep(-0.2,0.6,land));
        base += uCol*0.12*bands;
        float city = step(0.62, fbm(p*5.))*(1.-lit)*uAlive;
        float fres = pow(1.-max(dot(vN,vV),0.),3.);
        vec3 col = base*(0.25+lit*1.1) + uCol*city*0.9 + uCol*fres*1.6*uAlive + vec3(0.6,0.7,0.8)*fres*0.15;
        gl_FragColor = vec4(col, 1.); }`,
  }), []);
  const label = useMemo(() => makeLabel(device.name, color,
    device.online ? `CPU ${(cpu * 100).toFixed(0)}%  ·  MEM ${(mem * 100).toFixed(0)}%` : "OFFLINE",
    device.online ? (device.currentTasks ? `${device.currentTasks} TASK${device.currentTasks > 1 ? "S" : ""} RUNNING` : "STANDING BY") : "awaiting signal"),
    [device.name, color, cpu.toFixed(2), mem.toFixed(2), device.currentTasks, device.online]);
  const cpuArc = useMemo(() => new THREE.Line(arcGeo(size + 0.2, cpu), new THREE.LineBasicMaterial({ color, transparent: true, opacity: device.online ? 0.95 : 0 })), [cpu, size, color, device.online]);
  const memArc = useMemo(() => new THREE.Line(arcGeo(size + 0.28, mem), new THREE.LineBasicMaterial({ color: "#8b9dff", transparent: true, opacity: device.online ? 0.75 : 0 })), [mem, size, device.online]);
  const halo = useMemo(() => glowTexture("rgba(140,230,255,1)"), []);

  useFrame(({ clock, camera }, dt) => {
    const t = clock.getElapsedTime();
    const sp = device.online ? (device.currentTasks ? 0.12 : 0.06) : 0.02;
    const a = phase + t * sp;
    group.current.position.set(Math.cos(a) * radius, Math.sin(a) * radius * incl, Math.sin(a) * radius);
    positions.current.set(device.id, group.current.position.clone());
    body.current.rotation.y += dt * 0.25;
    const s = selected ? 1.35 : hover ? 1.18 : 1;
    body.current.scale.lerp(new THREE.Vector3(s, s, s), dt * 6);
    mat.uniforms.uTime.value = t;
    (mat.uniforms.uCol.value as THREE.Color).lerp(new THREE.Color(color), dt * 3);
    hud.current.quaternion.copy(camera.quaternion);
  });

  return (
    <group ref={group}>
      <sprite scale={[size * 6, size * 6, 1]}><spriteMaterial map={halo} color={color} transparent depthWrite={false} blending={THREE.AdditiveBlending} opacity={device.online ? 0.55 : 0.12} /></sprite>
      <mesh ref={body} material={mat}
        onClick={(e) => { e.stopPropagation(); onSelect(device.id); }}
        onPointerOver={(e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = "pointer"; }}
        onPointerOut={() => { setHover(false); document.body.style.cursor = "default"; }}>
        <sphereGeometry args={[size, 32, 24]} />
      </mesh>
      <group ref={hud}>
        <primitive object={cpuArc} />
        <primitive object={memArc} />
        {(selected || hover) && <mesh><ringGeometry args={[size + 0.4, size + 0.43, 64]} /><meshBasicMaterial color={color} transparent opacity={0.9} /></mesh>}
        <primitive object={label} position={[size * 0.7, size * 0.7, 0]} />
      </group>
    </group>
  );
}

/** Live link from the core to each online device; pulses travel along it while that device is working. */
function Links({ devices, positions }: { devices: Device[]; positions: React.MutableRefObject<Map<string, THREE.Vector3>> }) {
  const MAX = 24;
  const lines = useMemo(() => Array.from({ length: MAX }, () => {
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(40 * 3), 3));
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: "#2fd5ff", transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
  }), []);
  const pulses = useMemo(() => {
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX * 4 * 3), 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: "#d9fdff", size: 0.12, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  }, []);
  const curve = useMemo(() => new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()), []);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    const pp = pulses.geometry.getAttribute("position") as THREE.BufferAttribute;
    let k = 0;
    lines.forEach((ln, i) => {
      const d = devices[i]; const pos = d && positions.current.get(d.id);
      const mat = ln.material as THREE.LineBasicMaterial;
      if (!d || !pos || !d.online) { mat.opacity = 0; return; }
      curve.v0.set(0, 0, 0); curve.v2.copy(pos);
      curve.v1.copy(pos).multiplyScalar(0.5).add(new THREE.Vector3(0, 1.2 + pos.length() * 0.08, 0));
      const arr = ln.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let j = 0; j < 40; j++) { const v = curve.getPoint(j / 39); arr.setXYZ(j, v.x, v.y, v.z); }
      arr.needsUpdate = true;
      mat.color.set(statusColor(d)); mat.opacity = d.currentTasks ? 0.55 : 0.18;
      const nP = d.currentTasks ? 4 : 1;
      for (let q = 0; q < nP && k < MAX * 4; q++, k++) {
        const u = ((t * (d.currentTasks ? 0.45 : 0.15) + q / nP + i * 0.13) % 1);
        const v = curve.getPoint(u); pp.setXYZ(k, v.x, v.y, v.z);
      }
    });
    for (; k < MAX * 4; k++) pp.setXYZ(k, 0, -999, 0);
    pp.needsUpdate = true;
  });
  return <group>{lines.map((l, i) => <primitive key={i} object={l} />)}<primitive object={pulses} /></group>;
}

function Dust({ state, serious }: { state: CoreState; serious: boolean }) {
  const p = pal(state, serious);
  const { geo, speeds } = useMemo(() => {
    const n = 1000, pos = new Float32Array(n * 3), sp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = 1.4 + Math.pow(Math.random(), 1.6) * 9, a = Math.random() * Math.PI * 2;
      pos.set([Math.cos(a) * r, (Math.random() - 0.5) * 0.35 * (r / 3), Math.sin(a) * r], i * 3);
      sp[i] = 0.4 / Math.sqrt(r);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return { geo: g, speeds: sp };
  }, []);
  const mat = useRef<THREE.PointsMaterial>(null!);
  useFrame((_, dt) => {
    const a = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < a.count; i++) {
      const x = a.getX(i), z = a.getZ(i), w = speeds[i] * dt * (0.4 + p.speed);
      a.setX(i, x * Math.cos(w) - z * Math.sin(w)); a.setZ(i, x * Math.sin(w) + z * Math.cos(w));
    }
    a.needsUpdate = true;
    mat.current.color.lerp(new THREE.Color(p.core), dt * 2);
  });
  return <points geometry={geo} rotation={[0.06, 0, 0.04]}><pointsMaterial ref={mat} size={0.03} transparent opacity={0.6} depthWrite={false} blending={THREE.AdditiveBlending} color={p.core} /></points>;
}

function Rig({ selected, positions }: { selected: string | null; positions: React.MutableRefObject<Map<string, THREE.Vector3>> }) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3());
  useFrame(({ pointer, clock }, dt) => {
    const t = clock.getElapsedTime();
    const focus = selected ? positions.current.get(selected) : null;
    const desired = focus
      ? focus.clone().multiplyScalar(1.15).add(new THREE.Vector3(1.4, 1.3, 3.2))
      : new THREE.Vector3(Math.sin(t * 0.04) * 1.2 + pointer.x * 1.4, 3.1 + pointer.y * 0.8 + Math.sin(t * 0.06) * 0.3, 11.5);
    camera.position.lerp(desired, dt * (focus ? 2.2 : 1.2));
    look.current.lerp(focus ?? new THREE.Vector3(1.9, 0.2, 0), dt * 2.5);
    camera.lookAt(look.current);
  });
  return null;
}

function Scene({ state, level, devices, selected, onSelect, reducedMotion, serious }: {
  state: CoreState; level: React.MutableRefObject<number>; devices: Device[]; selected: string | null; onSelect: (id: string) => void; reducedMotion: boolean; serious: boolean;
}) {
  const positions = useRef(new Map<string, THREE.Vector3>());
  return (
    <>
      <Nebula serious={serious} />
      <Stars />
      <Core state={state} level={level} serious={serious} />
      <Dust state={state} serious={serious} />
      <Links devices={devices} positions={positions} />
      {devices.map((d, i) => <Planet key={d.id} device={d} index={i} count={devices.length} selected={selected === d.id} onSelect={onSelect} positions={positions} />)}
      <Rig selected={selected} positions={positions} />
      {!reducedMotion && (
        <EffectComposer multisampling={0}>
          <Bloom intensity={serious ? 1.25 : 0.95} luminanceThreshold={0.26} luminanceSmoothing={0.4} mipmapBlur radius={0.68} />
          <Vignette eskil={false} offset={0.24} darkness={serious ? 1.05 : 0.82} />
        </EffectComposer>
      )}
    </>
  );
}

export function Universe3D(props: {
  state: CoreState; level: React.MutableRefObject<number>; devices: Device[]; selected: string | null; onSelect: (id: string) => void; reducedMotion: boolean; serious: boolean;
}) {
  return (
    <Canvas camera={{ position: [0, 3.1, 11.5], fov: 44, near: 0.1, far: 200 }} dpr={[1, 1.5]}
      frameloop={props.reducedMotion ? "demand" : "always"}
      gl={{ antialias: false, alpha: false, powerPreference: "high-performance", toneMapping: THREE.ACESFilmicToneMapping }}
      onPointerMissed={() => props.onSelect("")}>
      <color attach="background" args={[props.serious ? "#0a0203" : "#02040a"]} />
      <Scene {...props} />
    </Canvas>
  );
}
