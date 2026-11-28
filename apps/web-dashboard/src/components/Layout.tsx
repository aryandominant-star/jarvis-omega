import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Api } from "../api";
import { useAuth } from "../auth";
import { Icon } from "./ui";

const NAV = [
  { to: "/", label: "Command", icon: Icon.core, end: true },
  { to: "/devices", label: "Devices", icon: Icon.devices },
  { to: "/tasks", label: "Tasks", icon: Icon.tasks },
  { to: "/workflows", label: "Workflows", icon: Icon.flows },
  { to: "/memory", label: "Memory", icon: Icon.memory },
  { to: "/logs", label: "Security Log", icon: Icon.logs },
  { to: "/settings", label: "Settings", icon: Icon.settings },
];

export function Layout({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  const { me, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const paused = me?.automationPaused;

  const toggle = async () => {
    setBusy(true);
    try {
      if (paused) await Api.resume();
      else if (confirm("Emergency stop: cancel every running task on every device and pause automation?")) await Api.emergencyStop();
      await refresh();
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="bg-layer bg-command" />
      <div className="grid-overlay" />
      <div className="scanline" />
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark" />
            <div>
              <div className="brand-name">J.A.R.V.I.S.</div>
              <div className="brand-sub">OMEGA · v1.1</div>
            </div>
          </div>
          <nav className="nav">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}>
                {n.icon}{n.label}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            SIGNED IN AS<br /><span style={{ color: "var(--cyan-soft)" }}>{me?.user.username}</span>
          </div>
        </aside>
        <main className="main">
          <header className="topbar">
            <h1>{title}</h1>
            <div className="spacer" />
            {right}
            <button className={paused ? "btn amber" : "btn danger"} onClick={toggle} disabled={busy} title="Stops all automation on every device">
              {Icon.stop}{paused ? "Resume automation" : "Emergency stop"}
            </button>
          </header>
          <div className="content">
            {paused && (
              <div className="banner">
                <span className="dot warn" /> Automation is paused. Devices will not start or continue any task until you resume.
              </div>
            )}
            {children}
          </div>
        </main>
      </div>
    </>
  );
}
