import type { AuthSession } from "@cocean/contracts";
import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api.js";
import { PageShell } from "./components.js";
import { AlbumDetailPage } from "./pages/album-detail.js";
import { DiscoverPage } from "./pages/discover.js";
import { HomePage } from "./pages/home.js";
import { InformationMatchPage } from "./pages/information-match.js";
import { LibraryPage } from "./pages/library.js";
import { LoginPage } from "./pages/login.js";
import { SettingsPage } from "./pages/settings.js";
import { SystemsPage } from "./pages/systems.js";
import { TasksPage } from "./pages/tasks.js";
import { applyTheme } from "./theme.js";

export function App() {
  const [session, setSession] = useState<AuthSession | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let active = true;
    void api
      .session()
      .then((value) => {
        if (active) setSession(value);
      })
      .catch(() => {
        if (active) setSession(null);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void api
      .settings()
      .then((settings) => {
        if (active) applyTheme(settings.theme);
      })
      .catch(() => {
        // A cached or system theme remains active while the API is unavailable.
      });
    return () => {
      active = false;
    };
  }, []);
  if (session === undefined)
    return <div className="auth-loading">正在连接 COCEAN…</div>;
  if (session === null)
    return (
      <Routes>
        <Route path="/login" element={<LoginPage onLogin={setSession} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  const canManage = session.user.role === "ADMIN";
  return (
    <PageShell
      user={session.user}
      onLogout={() => {
        void api.logout().finally(() => setSession(null));
      }}
    >
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/" element={<HomePage />} />
        <Route path="/today" element={<HomePage />} />
        <Route
          path="/library"
          element={<LibraryPage canManage={canManage} />}
        />
        <Route
          path="/albums/:id"
          element={<AlbumDetailPage canManage={canManage} />}
        />
        <Route
          path="/albums/:id/match"
          element={<InformationMatchPage canManage={canManage} />}
        />
        <Route
          path="/albums/:id/information-match"
          element={<InformationMatchPage canManage={canManage} />}
        />
        <Route path="/discover" element={<DiscoverPage />} />
        <Route path="/find" element={<DiscoverPage />} />
        <Route
          path="/systems"
          element={<SystemsPage canManage={canManage} />}
        />
        <Route path="/system" element={<SystemsPage canManage={canManage} />} />
        <Route path="/tasks" element={<TasksPage canManage={canManage} />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </PageShell>
  );
}
