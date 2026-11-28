import { useEffect, useState } from "react";

/**
 * Cinematic "MADE BY ARYAN" boot sequence. Plays once per browser session
 * (sessionStorage), then unmounts so it never costs a frame afterward.
 */
export function BootIntro() {
  const [show, setShow] = useState(() => {
    try { return sessionStorage.getItem("jarvis-booted") !== "1"; } catch { return true; }
  });

  useEffect(() => {
    if (!show) return;
    try { sessionStorage.setItem("jarvis-booted", "1"); } catch { /* ignore */ }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(() => setShow(false), reduced ? 2200 : 4200);
    return () => clearTimeout(t);
  }, [show]);

  if (!show) return null;
  return (
    <div className="boot-intro" onClick={() => setShow(false)}>
      <div className="boot-ring" />
      <div className="boot-ring r2" />
      <div className="boot-ring r3" />
      <div className="boot-scan" />
      <div className="boot-made">Made by</div>
      <div className="boot-aryan">Aryan</div>
      <div className="boot-sub">J.A.R.V.I.S. · OMEGA</div>
    </div>
  );
}
