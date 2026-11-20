import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router";
import { AlertsPage } from "./pages/AlertsPage";
import { BillingPage } from "./pages/BillingPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ImportPage } from "./pages/ImportPage";
import { InvitePage } from "./pages/InvitePage";
import { LoginPage } from "./pages/LoginPage";
import { PersonDetailPage } from "./pages/PersonDetailPage";
import { PersonsPage } from "./pages/PersonsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { SitesPage } from "./pages/SitesPage";
import { UsersPage } from "./pages/UsersPage";
import { PlatformApp } from "./platform/PlatformApp";
import { SessionProvider, useSession, type Me } from "./session";
import { fmtDateTime } from "./ui";
import { USER_ROLE_LABEL } from "@zairyu/shared";

/** 未払い時のお知らせ(1-18)。猶予中は案内だけ、猶予後は新しい登録者の追加だけが止まる */
function BillingBanner({ billing, canManage }: { billing: Me["billing"]; canManage: boolean }) {
  if (billing.state === "ok") return null;
  const link = canManage ? <Link to="/billing">契約・請求を確認する</Link> : <>テナント管理者にお問い合わせください。</>;
  return billing.state === "grace" ? (
    <p className="msg msg-warn banner">
      お支払いが確認できていません。
      {billing.graceEndsAt ? `${fmtDateTime(billing.graceEndsAt)} を過ぎると、` : "このままでは、"}
      新しい登録者を追加できなくなります(閲覧と期限アラートは続きます)。{link}
    </p>
  ) : (
    <p className="msg msg-danger banner">
      お支払いが確認できないため、新しい登録者の追加を停止しています。閲覧・カードの更新・期限アラートは引き続き使えます。{link}
    </p>
  );
}

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
        {session.can("imports.run") && <NavLink to="/import">CSV 取込</NavLink>}
        {session.can("reports.export") && <NavLink to="/reports">履歴の出力</NavLink>}
        {session.can("org.manage") && (
          <>
            <span className="nav-head">組織</span>
            <NavLink to="/org/sites">拠点</NavLink>
            <NavLink to="/org/users">ユーザー</NavLink>
            {session.can("billing.manage") && <NavLink to="/billing">契約・請求</NavLink>}
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
        <BillingBanner billing={me.billing} canManage={session.can("billing.manage")} />
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/persons" element={<PersonsPage />} />
          <Route path="/persons/:id" element={<PersonDetailPage />} />
          <Route path="/alerts" element={<AlertsPage />} />
          {session.can("imports.run") && <Route path="/import" element={<ImportPage />} />}
          {session.can("reports.export") && <Route path="/reports" element={<ReportsPage />} />}
          {session.can("org.manage") && <Route path="/org/sites" element={<SitesPage />} />}
          {session.can("org.manage") && <Route path="/org/users" element={<UsersPage />} />}
          {session.can("billing.manage") && <Route path="/billing" element={<BillingPage />} />}
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
        {/* 運営者コンソール(テナントとは別のログイン) */}
        <Route path="/platform/*" element={<PlatformApp />} />
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
