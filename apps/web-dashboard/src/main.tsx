import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { BootIntro } from "./components/BootIntro";
import { Universe } from "./pages/Universe";
import { Assistant } from "./pages/Assistant";
import { Devices } from "./pages/Devices";
import { Login } from "./pages/Login";
import { Logs, Memory, Settings, Workflows } from "./pages/Other";
import { Tasks } from "./pages/Tasks";
import "./styles.css";

/** Every route is gated: without a valid username/password session only the sign-in screen renders. */
function Gate() {
  const { me, loading } = useAuth();
  useEffect(() => { document.body.classList.toggle("reduced-motion", !!me?.settings.reducedMotion); }, [me?.settings.reducedMotion]);
  if (loading) return <div className="empty" style={{ paddingTop: "40vh" }}>Initialising…</div>;
  if (!me) return <Login />;
  return (
    <Routes>
      <Route path="/" element={<Universe />} />
      <Route path="/assistant" element={<Assistant />} />
      <Route path="/devices" element={<Devices />} />
      <Route path="/tasks" element={<Tasks />} />
      <Route path="/workflows" element={<Workflows />} />
      <Route path="/memory" element={<Memory />} />
      <Route path="/logs" element={<Logs />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <BootIntro />
      {/* Hash routing works on any static host (InfinityFree included) without server rewrites. */}
      <HashRouter><Gate /></HashRouter>
    </AuthProvider>
  </StrictMode>
);
