import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { LockScreen } from "./src/auth/LockScreen";
import { LoginScreen } from "./src/auth/LoginScreen";
import { SessionProvider, useSession } from "./src/auth/session";
import { IcPocScreen } from "./src/IcPocScreen";
import { AlertsScreen } from "./src/screens/AlertsScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { PersonCreateScreen } from "./src/screens/PersonCreateScreen";
import { PersonScreen } from "./src/screens/PersonScreen";
import { Button } from "./src/ui/kit";
import { CardWizard } from "./src/wizard/CardWizard";

type Route =
  | { name: "home" }
  | { name: "person"; id: string }
  | { name: "wizard"; personId: string; personName: string }
  | { name: "personCreate" }
  | { name: "alerts" }
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
    case "alerts":
      return <AlertsScreen onBack={() => setRoute({ name: "home" })} onOpenPerson={(id) => setRoute({ name: "person", id })} />;
    case "personCreate":
      return <PersonCreateScreen onBack={() => setRoute({ name: "home" })} onCreated={(id) => setRoute({ name: "person", id })} />;
    case "person":
      return (
        <PersonScreen
          key={`${route.id}:${reloadKey}`}
          personId={route.id}
          onBack={() => setRoute({ name: "home" })}
          onRegisterCard={(personName) => setRoute({ name: "wizard", personId: route.id, personName })}
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
          onCreatePerson={() => setRoute({ name: "personCreate" })}
          onOpenAlerts={() => setRoute({ name: "alerts" })}
        />
      );
  }
}

export default function App() {
  return (
    <SessionProvider>
      <Main />
      <StatusBar style="dark" />
    </SessionProvider>
  );
}
