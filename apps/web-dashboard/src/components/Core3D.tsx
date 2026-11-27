import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

export type CoreState = "idle" | "listening" | "thinking" | "executing" | "speaking" | "error" | "offline";

const PALETTE: Record<CoreState, { color: string; speed: number; glow: number; particles: number }> = {
  idle: { color: "#00e5ff", speed: 0.15, glow: 0.8, particles: 0.25 },
  listening: { color: "#7df3ff", speed: 0.35, glow: 1.2, particles: 0.5 },
  thinking: { color: "#00e5ff", speed: 0.9, glow: 1.3, particles: 1.6 },
  executing: { color: "#2ad4ff", speed: 1.4, glow: 1.5, particles: 2.2 },
  speaking: { color: "#9ff8ff", speed: 0.5, glow: 1.4, particles: 0.8 },
  error: { color: "#ffb547", speed: 0.2, glow: 0.9, particles: 0.2 },
  offline: { color: "#35506a", speed: 0.04, glow: 0.25, particles: 0.05 },
};

function Ring({ radius, tilt, speed, color, dashed, width = 0.012 }: { radius: number; tilt: [number, number, number]; speed: number; color: string; dashed?: boolean; width?: number }) {
  const ref = useRef<THREE.Mesh>(null!);
  const geo = useMemo(() => new THREE.TorusGeometry(radius, width, 8, dashed ? 64 : 220), [radius, width, dashed]);
  useFrame((_, dt) => { ref.current.rotation.z += dt * speed; });
  return (
    <group rotation={tilt}>
      <mesh ref={ref} geometry={geo}>
        <meshBasicMaterial color={color} transparent opacity={dashed ? 0.45 : 0.85} wireframe={dashed} />
      </mesh>
    </group>
  );
}

function TickRing({ radius, color, speed }: { radius: number; color: string; speed: number }) {
  const ref = useRef<THREE.LineSegments>(null!);
  const geo = useMemo(() => {
    const pts: number[] = [];
    for (let i = 0; i < 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const len = i % 10 === 0 ? 0.12 : 0.05;
      pts.push(Math.cos(a) * radius, Math.sin(a) * radius, 0, Math.cos(a) * (radius + len), Math.sin(a) * (radius + len), 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, [radius]);
  useFrame((_, dt) => { ref.current.rotation.z -= dt * speed * 0.6; });
  return (
    <lineSegments ref={ref} geometry={geo}>
      <lineBasicMaterial color={color} transparent opacity={0.55} />
    </lineSegments>
  );
}

function Particles({ intensity, color }: { intensity: number; color: string }) {
  const ref = useRef<THREE.Points>(null!);
  const { geo, speeds } = useMemo(() => {
    const n = 900;
    const pos = new Float32Array(n * 3);
    const sp = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = 1.3 + Math.random() * 2.4;
      const a = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * 1.6;
      pos.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
      sp[i] = 0.2 + Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return { geo: g, speeds: sp };
  }, []);
  useFrame((_, dt) => {
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const a = speeds[i] * dt * 0.25 * intensity;
      p.setX(i, x * Math.cos(a) - z * Math.sin(a));
      p.setZ(i, x * Math.sin(a) + z * Math.cos(a));
    }
    p.needsUpdate = true;
  });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial color={color} size={0.022} transparent opacity={0.75} sizeAttenuation depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
}

function CoreOrb({ state, level }: { state: CoreState; level: React.MutableRefObject<number> }) {
  const p = PALETTE[state];
  const inner = useRef<THREE.Mesh>(null!);
  const shell = useRef<THREE.Mesh>(null!);
  const halo = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }, dt) => {
    const t = clock.getElapsedTime();
    const audio = state === "listening" || state === "speaking" ? level.current : 0;
    const beat = 1 + Math.sin(t * (state === "thinking" ? 5 : 1.6)) * 0.03 + audio * 0.35;
    inner.current.scale.setScalar(beat);
    shell.current.rotation.y += dt * p.speed * 0.8;
    shell.current.rotation.x += dt * p.speed * 0.3;
    (halo.current.material as THREE.MeshBasicMaterial).opacity = 0.12 * p.glow + audio * 0.2;
  });
  return (
    <group>
      <mesh ref={halo}><sphereGeometry args={[0.95, 32, 32]} /><meshBasicMaterial color={p.color} transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} /></mesh>
      <mesh ref={inner}><sphereGeometry args={[0.42, 48, 48]} /><meshBasicMaterial color={p.color} transparent opacity={0.9} /></mesh>
      <mesh ref={shell}><icosahedronGeometry args={[0.66, 1]} /><meshBasicMaterial color={p.color} wireframe transparent opacity={0.35} /></mesh>
    </group>
  );
}

function Scene({ state, level }: { state: CoreState; level: React.MutableRefObject<number> }) {
  const p = PALETTE[state];
  const group = useRef<THREE.Group>(null!);
  useFrame(({ pointer }, dt) => {
    group.current.rotation.y += (pointer.x * 0.25 - group.current.rotation.y) * dt * 2;
    group.current.rotation.x += (-pointer.y * 0.15 - group.current.rotation.x) * dt * 2;
  });
  return (
    <group ref={group}>
      <CoreOrb state={state} level={level} />
      <Ring radius={1.05} tilt={[Math.PI / 2.2, 0, 0]} speed={p.speed} color={p.color} />
      <Ring radius={1.32} tilt={[Math.PI / 2.6, 0.4, 0]} speed={-p.speed * 0.7} color={p.color} dashed />
      <Ring radius={1.6} tilt={[Math.PI / 1.9, -0.3, 0.2]} speed={p.speed * 0.5} color={p.color} width={0.008} />
      <group rotation={[Math.PI / 2.2, 0, 0]}><TickRing radius={1.85} color={p.color} speed={p.speed} /></group>
      <Particles intensity={p.particles} color={p.color} />
    </group>
  );
}

export function Core3D({ state, level, reducedMotion }: { state: CoreState; level: React.MutableRefObject<number>; reducedMotion: boolean }) {
  return (
    <Canvas
      className="core-canvas"
      camera={{ position: [0, 0.2, 4.6], fov: 45 }}
      dpr={[1, 2]}
      frameloop={reducedMotion ? "demand" : "always"}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
    >
      <Scene state={state} level={level} />
    </Canvas>
  );
}
