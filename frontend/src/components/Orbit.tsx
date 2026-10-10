import React, { useEffect, useRef } from 'react';
import logo from '../assets/tutupbuku-logo.png';

/* Ported from orbitanimation.html: two 3D-rotated elliptical orbits drawn on a canvas,
   DOM nodes placed by the same rotate → perspective-project math, mouse parallax,
   depth-sorted z-index and depth-scaled opacity. Changes from the original:
   - sizes derive from the container instead of fixed 100/65 radii,
   - time is accumulated (not read from the clock) so speed can follow the real run state,
   - the loop pauses when hidden/offscreen and renders one still frame under reduced motion,
   - nodes are buttons carrying real stage state. */

export type OrbitMode = 'idle' | 'running' | 'waiting' | 'done' | 'error';
export interface OrbitNode { id: string; label: string; status: string; icon: 'document' | 'filter' | 'link' | 'person' | 'arrow' }

const SPEED: Record<OrbitMode, number> = { idle: 0.7, running: 2.4, waiting: 0.4, done: 0.8, error: 0.2 };
const SPEED_1 = 0.00042, SPEED_2 = -0.00034, PLANE_1 = 0.0003, PLANE_2 = -0.00045, RESOLUTION = 160;

type V3 = { x: number; y: number; z: number };
type Rot = { x: number; y: number; z: number };
const rotate = (p: V3, r: Rot): V3 => {
  const cx = Math.cos(r.x), sx = Math.sin(r.x);
  const a = { x: p.x, y: p.y * cx - p.z * sx, z: p.y * sx + p.z * cx };
  const cy = Math.cos(r.y), sy = Math.sin(r.y);
  const b = { x: a.x * cy + a.z * sy, y: a.y, z: -a.x * sy + a.z * cy };
  const cz = Math.cos(r.z), sz = Math.sin(r.z);
  return { x: b.x * cz - b.y * sz, y: b.x * sz + b.y * cz, z: b.z };
};

const ORBITS = [
  { rotation: { x: 0.75, y: -0.35, z: -0.25 }, phase: 0, speed: SPEED_1, plane: PLANE_1 },
  { rotation: { x: -0.7, y: 0.45, z: 0.25 }, phase: Math.PI / 2, speed: SPEED_2, plane: PLANE_2 },
];

const ICONS: Record<OrbitNode['icon'], React.ReactNode> = {
  document: <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v5h5" /><path d="M12 11v7" /><path d="M9.5 14.5L12 17l2.5-2.5" /></>,
  filter: <><path d="M4 5h16" /><path d="M7 10h10" /><path d="M10 15h4" /><path d="M4 5l6 7v7h4v-7l6-7" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  person: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" /><path d="M16.5 4.5l1.5 1.5 3-3" /></>,
  arrow: <><path d="M5 19L19 5" /><path d="M10 5h9v9" /></>,
};

export function Orbit({ nodes, mode, activeId, onSelect }: { nodes: OrbitNode[]; mode: OrbitMode; activeId?: string; onSelect?: (id: string) => void }) {
  const scene = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const count = nodes.length;

  useEffect(() => {
    const el = scene.current, cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!el || !cv || !ctx) return;

    let width = 0, height = 0, raf = 0, last = 0, sim = 0, mult = SPEED[modeRef.current];
    let mouseX = 0, mouseY = 0, targetX = 0, targetY = 0, visible = true;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    const resize = () => {
      const rect = el.getBoundingClientRect();
      width = rect.width; height = rect.height;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(width * dpr)); cv.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reduced.matches) frame(0);
    };

    const frame = (dt: number) => {
      const target = SPEED[modeRef.current];
      mult += (target - mult) * Math.min(1, dt * 0.004);
      sim += dt * mult;
      mouseX += (targetX - mouseX) * 0.04; mouseY += (targetY - mouseY) * 0.04;

      const R = Math.min(width * 0.62, height) * 0.5;
      const radiusX = R, radiusY = R * 0.65, perspective = R * 10.5;
      const project = (p: V3) => { const s = perspective / (perspective - p.z); return { x: width / 2 + p.x * s, y: height / 2 + p.y * s, scale: s, z: p.z }; };
      const planeAt = (o: typeof ORBITS[number]): Rot => ({
        x: o.rotation.x + Math.sin(sim * 0.00025) * 0.15 + mouseY * 0.12,
        y: o.rotation.y + Math.cos(sim * 0.0002) * 0.15 + mouseX * 0.12,
        z: o.rotation.z + sim * o.plane,
      });

      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(47, 111, 224, 0.28)';
      ctx.lineWidth = 1.2;
      const planes = ORBITS.map(planeAt);
      planes.forEach(rot => {
        ctx.beginPath();
        for (let i = 0; i <= RESOLUTION; i++) {
          const a = (i / RESOLUTION) * Math.PI * 2;
          const p = project(rotate({ x: Math.cos(a) * radiusX, y: Math.sin(a) * radiusY, z: 0 }, rot));
          if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      });

      // Orbit 0 carries nodes 0,2,4…, orbit 1 carries 1,3,… — evenly spaced on each path.
      const slots = [0, 1].map(oi => nodes.map((_, i) => i).filter(i => i % 2 === oi));
      slots.forEach((indices, oi) => {
        const o = ORBITS[oi];
        indices.forEach((nodeIndex, k) => {
          const el = items.current[nodeIndex];
          if (!el) return;
          const angle = o.phase + sim * o.speed + (k / indices.length) * Math.PI * 2;
          const pos = project(rotate({ x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY, z: 0 }, planes[oi]));
          const scale = Math.max(0.78, Math.min(1.18, pos.scale));
          el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) translate(-50%, -50%) scale(${scale})`;
          el.style.opacity = String(0.78 + (scale - 0.78) * 0.7 + 0.1);
          el.style.zIndex = String(Math.round(10 + pos.z));
        });
      });
    };

    const loop = (now: number) => {
      const dt = last ? Math.min(now - last, 50) : 16;
      last = now;
      frame(dt);
      raf = requestAnimationFrame(loop);
    };
    const start = () => { if (!raf && visible && !document.hidden && !reduced.matches) { last = 0; raf = requestAnimationFrame(loop); } };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      targetX = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
      targetY = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
    };
    const onLeave = () => { targetX = 0; targetY = 0; };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onMotionPref = () => { stop(); if (reduced.matches) frame(0); else start(); };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(el);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) start(); else stop(); });
    intersection.observe(el);
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', onMotionPref);
    resize();
    frame(0);
    start();

    return () => {
      stop();
      resizeObserver.disconnect(); intersection.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', onMotionPref);
    };
  }, [count]);

  return <div ref={scene} className={`orbit orbit-${mode}`} role="group" aria-label="Execution stages">
    <canvas ref={canvas} className="orbit-canvas" aria-hidden="true" />
    <div className="orbit-core" aria-hidden="true"><img src={logo} alt="" draggable={false} /></div>
    {nodes.map((node, i) => <button key={node.id} type="button" ref={el => { items.current[i] = el; }}
      className={`orbit-node ${node.status} ${activeId === node.id ? 'active' : ''}`}
      aria-label={`${node.label}: ${node.status.replace(/_/g, ' ')}`} aria-pressed={activeId === node.id}
      onClick={() => onSelect?.(node.id)}>
      <svg viewBox="0 0 24 24" aria-hidden="true">{ICONS[node.icon]}</svg>
      <span className="orbit-node-label">{node.label}</span>
    </button>)}
  </div>;
}
