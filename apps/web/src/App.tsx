import { BrowserRouter, Navigate, NavLink, Route, Routes } from "react-router";
import { AlertsPage } from "./pages/AlertsPage";
import { DashboardPage } from "./pages/DashboardPage";
import { InvitePage } from "./pages/InvitePage";
import { LoginPage } from "./pages/LoginPage";
import { PersonDetailPage } from "./pages/PersonDetailPage";
import { PersonsPage } from "./pages/PersonsPage";
import { SitesPage } from "./pages/SitesPage";
import { UsersPage } from "./pages/UsersPage";
import { SessionProvider, useSession } from "./session";
import { USER_ROLE_LABEL } from "@zairyu/shared";

function Shell() {
  const session = useSession();
  if (session.state.status === "loading") return <main className="center">読み込み中…</main>;
  if (session.state.status === "signedOut") return <LoginPage />;
  const me = session.state.me;
  return (
    <div className="layout">
      <nav>
        <strong className="brand">在留カード管理</strong>
        <NavLink to="/" end>
          ダッシュボード
        </NavLink>
        <NavLink to="/persons">登録者</NavLink>
        {session.can("alerts.read") && <NavLink to="/alerts">アラート</NavLink>}
        {session.can("org.manage") && (
          <>
            <span className="nav-head">組織</span>
            <NavLink to="/org/sites">拠点</NavLink>
            <NavLink to="/org/users">ユーザー</NavLink>
          </>
        )}
        <div className="nav-foot">
          <div>{me.email}</div>
          <div className="sub">{USER_ROLE_LABEL[me.role]}</div>
          <button className="link" onClick={() => void session.logout()}>
            ログアウト
          </button>
        </div>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/persons" element={<PersonsPage />} />
          <Route path="/persons/:id" element={<PersonDetailPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          {session.can("org.manage") && <Route path="/org/sites" element={<SitesPage />} />}
          {session.can("org.manage") && <Route path="/org/users" element={<UsersPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* 招待リンクはログイン前に開く */}
        <Route path="/invite" element={<InvitePage />} />
        <Route
          path="*"
          element={
            <SessionProvider>
              <Shell />
            </SessionProvider>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
