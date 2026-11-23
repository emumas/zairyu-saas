import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { LockScreen } from "./src/auth/LockScreen";
import { LoginScreen } from "./src/auth/LoginScreen";
import { SessionProvider, useSession } from "./src/auth/session";
import { IcPocScreen } from "./src/IcPocScreen";
import { AlertsScreen } from "./src/screens/AlertsScreen";
import { CardDetailsScreen } from "./src/screens/CardDetailsScreen";
import { PhotoRetakeScreen } from "./src/screens/PhotoRetakeScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { PersonCreateScreen } from "./src/screens/PersonCreateScreen";
import { PersonScreen, type Person } from "./src/screens/PersonScreen";
import { ReverifyScreen } from "./src/screens/ReverifyScreen";
import { RevocationCheckScreen } from "./src/screens/RevocationCheckScreen";
import { Button } from "./src/ui/kit";
import { PrivacyShield } from "./src/ui/PrivacyShield";
import { CardWizard } from "./src/wizard/CardWizard";

type Route =
  | { name: "home" }
  | { name: "person"; id: string }
  | { name: "wizard"; personId: string; personName: string }
  | { name: "personCreate" }
  | { name: "newPerson" }
  | { name: "alerts" }
  | { name: "revocation"; cardId: string; personId: string; personName: string }
  | { name: "reverify"; cardId: string; personId: string; personName: string }
  | { name: "cardDetails"; personId: string; personName: string }
  | { name: "photoRetake"; cardId: string; personId: string; personName: string; current: { address: string | null; addressSource: string | null } }
  | { name: "personEdit"; person: Person }
  | { name: "poc" };

function Main() {
  const session = useSession();
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [reloadKey, setReloadKey] = useState(0);

  if (session.state.status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }
  if (session.state.status === "signedOut") return <LoginScreen />;
  // ロック中は画面ごと外す(表示していた個人情報を残さない)
  if (session.state.status === "locked") return <LockScreen />;

  switch (route.name) {
    case "poc":
      return (
        <View style={{ flex: 1 }}>
          <IcPocScreen />
          <View style={{ padding: 16 }}>
            <Button label="戻る" kind="secondary" onPress={() => setRoute({ name: "home" })} />
          </View>
        </View>
      );
    case "reverify":
      return (
        <ReverifyScreen
          cardId={route.cardId}
          personName={route.personName}
          onDone={() => {
            setReloadKey((k) => k + 1);
            setRoute({ name: "person", id: route.personId });
          }}
        />
      );
    case "revocation":
      return (
        <RevocationCheckScreen
          cardId={route.cardId}
          personName={route.personName}
          onDone={() => {
            setReloadKey((k) => k + 1);
            setRoute({ name: "person", id: route.personId });
          }}
        />
      );
    case "alerts":
      return <AlertsScreen onBack={() => setRoute({ name: "home" })} onOpenPerson={(id) => setRoute({ name: "person", id })} />;
    case "newPerson":
      // カードを先に読み取り、その内容で登録者を作る
      return (
        <CardWizard
          personName="新しい登録者"
          onClose={() => setRoute({ name: "home" })}
          onManualEntry={() => setRoute({ name: "personCreate" })}
          onDone={(id) => {
            setReloadKey((k) => k + 1);
            setRoute({ name: "person", id });
          }}
        />
      );
    case "personCreate":
      return <PersonCreateScreen onBack={() => setRoute({ name: "home" })} onCreated={(id) => setRoute({ name: "person", id })} />;
    case "person":
      return (
        <PersonScreen
          key={`${route.id}:${reloadKey}`}
          personId={route.id}
          onBack={() => setRoute({ name: "home" })}
          onRegisterCard={(personName) => setRoute({ name: "wizard", personId: route.id, personName })}
          onRevocationCheck={(cardId, personName) => setRoute({ name: "revocation", cardId, personId: route.id, personName })}
          onReverify={(cardId, personName) => setRoute({ name: "reverify", cardId, personId: route.id, personName })}
          onEditDetails={(personName) => setRoute({ name: "cardDetails", personId: route.id, personName })}
          onEditPerson={(person) => setRoute({ name: "personEdit", person })}
          onRetakePhotos={(cardId, personName, current) => setRoute({ name: "photoRetake", cardId, personId: route.id, personName, current })}
        />
      );
    case "personEdit":
      return (
        <PersonCreateScreen
          person={route.person}
          onBack={() => setRoute({ name: "person", id: route.person.id })}
          onCreated={(id) => {
            setReloadKey((k) => k + 1);
            setRoute({ name: "person", id });
          }}
        />
      );
    case "photoRetake":
      return (
        <PhotoRetakeScreen
          cardId={route.cardId}
          personName={route.personName}
          current={route.current}
          onClose={() => setRoute({ name: "person", id: route.personId })}
          onSaved={() => setReloadKey((k) => k + 1)}
          onReadDetails={() => setRoute({ name: "cardDetails", personId: route.personId, personName: route.personName })}
        />
      );
    case "cardDetails":
      return (
        <CardDetailsScreen
          personId={route.personId}
          personName={route.personName}
          onClose={() => setRoute({ name: "person", id: route.personId })}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      );
    case "wizard":
      return (
        <CardWizard
          personId={route.personId}
          personName={route.personName}
          onClose={() => setRoute({ name: "person", id: route.personId })}
          onDone={() => {
            setReloadKey((k) => k + 1);
            setRoute({ name: "person", id: route.personId });
          }}
        />
      );
    default:
      return (
        <HomeScreen
          onOpenPerson={(id) => setRoute({ name: "person", id })}
          onOpenPoc={() => setRoute({ name: "poc" })}
          onCreatePerson={() => setRoute({ name: "newPerson" })}
          onOpenAlerts={() => setRoute({ name: "alerts" })}
        />
      );
  }
}

export default function App() {
  return (
    <PrivacyShield>
      <SessionProvider>
        <Main />
        <StatusBar style="dark" />
      </SessionProvider>
    </PrivacyShield>
  );
}
