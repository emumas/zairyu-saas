/** 共通の画面部品(最小限) */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Keyboard,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type ScrollViewInstance,
  type TextInputProps,
  View,
} from "react-native";

export const color = {
  primary: "#0b5cad",
  danger: "#cf222e",
  warn: "#9a6700",
  ok: "#1a7f37",
  text: "#1f2328",
  sub: "#59636e",
  border: "#d1d9e0",
  bg: "#ffffff",
  muted: "#f6f8fa",
};

/** 入力欄にフォーカスが移ったとき、キーボードに隠れないようにスクロールする(Screen が提供) */
const KeyboardContext = createContext<() => void>(() => {});

/** キーボードの上にこれだけ余白を空ける */
const KEYBOARD_GAP = 24;

/**
 * 画面の枠(スクロール)。キーボードが出ている間は下に同じ高さの余白を足し、
 * フォーカスした入力欄がキーボードに隠れていればその分スクロールする。
 * (Android の edge-to-edge ではウィンドウのリサイズが効かないため、JS 側で調整する)
 */
export function Screen({
  children,
  title,
  onBack,
  right,
  refreshing,
  onRefresh,
}: {
  children: ReactNode;
  title?: string;
  onBack?: () => void;
  right?: ReactNode;
  /** 引っ張って更新 */
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  const scrollY = useRef(0);
  const keyboardTop = useRef<number | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const ensureFocusedVisible = useCallback(() => {
    const input = TextInput.State.currentlyFocusedInput();
    const top = keyboardTop.current;
    if (!input || top === null) return;
    input.measureInWindow((_x, y, _w, h) => {
      const overflow = y + h + KEYBOARD_GAP - top;
      // 隠れている分だけ下へ。上に出すぎている(画面の上端より上)ときは戻す
      if (overflow > 0) scrollRef.current?.scrollTo({ y: scrollY.current + overflow, animated: true });
      else if (y < 80) scrollRef.current?.scrollTo({ y: Math.max(0, scrollY.current + y - 80), animated: true });
    });
  }, []);

  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      // キーボードの上端(画面の座標)。取れない端末では画面の高さから引く
      keyboardTop.current = e.endCoordinates.screenY > 0 ? e.endCoordinates.screenY : Dimensions.get("window").height - e.endCoordinates.height;
      setKeyboardHeight(e.endCoordinates.height);
      // 余白を足した後のレイアウトで測る
      setTimeout(ensureFocusedVisible, 50);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      keyboardTop.current = null;
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [ensureFocusedVisible]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.nativeEvent.contentOffset.y;
  };

  return (
    <KeyboardContext.Provider value={ensureFocusedVisible}>
      <ScrollView
        ref={scrollRef}
        style={{ backgroundColor: color.bg }}
        contentContainerStyle={[s.screen, keyboardHeight ? { paddingBottom: keyboardHeight + KEYBOARD_GAP } : null]}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
      >
        {(title || onBack) && (
          <View style={s.header}>
            {onBack && (
              <Pressable onPress={onBack} hitSlop={12}>
                <Text style={s.back}>‹ 戻る</Text>
              </Pressable>
            )}
            <Text style={s.title} numberOfLines={1}>
              {title}
            </Text>
            <View style={{ marginLeft: "auto" }}>{right}</View>
          </View>
        )}
        {children}
      </ScrollView>
    </KeyboardContext.Provider>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  busy,
  kind = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  kind?: "primary" | "secondary" | "danger";
}) {
  const st = kind === "primary" ? s.primary : kind === "danger" ? s.dangerBtn : s.secondary;
  const tx = kind === "secondary" ? s.secondaryText : s.primaryText;
  return (
    <Pressable style={[s.button, st, (disabled || busy) && s.disabled]} onPress={onPress} disabled={disabled || busy}>
      {busy ? <ActivityIndicator color={kind === "secondary" ? color.primary : "#fff"} /> : <Text style={tx}>{label}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, onFocus, ...props }: TextInputProps & { label: string; error?: string | null | undefined }) {
  const ensureVisible = useContext(KeyboardContext);
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={[s.input, error ? { borderColor: color.danger } : null]}
        placeholderTextColor="#8c959f"
        {...props}
        onFocus={(e) => {
          onFocus?.(e);
          // キーボードが出たままほかの欄に移ったとき(初めて出るときは keyboardDidShow で調整する)
          setTimeout(ensureVisible, 100);
        }}
      />
      {error ? <Text style={s.error}>{error}</Text> : null}
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

export function Row({ k, v, tone }: { k: string; v: string; tone?: "ok" | "warn" | "danger" | undefined }) {
  return (
    <View style={s.row}>
      <Text style={s.key}>{k}</Text>
      <Text style={[s.value, tone ? { color: color[tone === "danger" ? "danger" : tone], fontWeight: "600" } : null]}>{v}</Text>
    </View>
  );
}

export function Message({ text, tone = "danger" }: { text: string | null | undefined; tone?: "danger" | "warn" | "ok" }) {
  if (!text) return null;
  return <Text style={{ color: color[tone] }}>{text}</Text>;
}

export function Choice<T extends string>({ options, value, onChange }: { options: readonly { value: T; label: string }[]; value: T | null; onChange: (v: T) => void }) {
  return (
    <View style={{ gap: 6 }}>
      {options.map((o) => (
        <Pressable key={o.value} onPress={() => onChange(o.value)} style={[s.choice, value === o.value && s.choiceOn]}>
          <Text style={value === o.value ? { color: color.primary, fontWeight: "600" } : null}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { padding: 20, paddingTop: 56, gap: 14, paddingBottom: 48 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  back: { color: color.primary, fontSize: 16 },
  title: { fontSize: 20, fontWeight: "700", color: color.text, flexShrink: 1 },
  button: { borderRadius: 8, paddingVertical: 14, paddingHorizontal: 16, alignItems: "center" },
  primary: { backgroundColor: color.primary },
  dangerBtn: { backgroundColor: color.danger },
  secondary: { borderWidth: 1, borderColor: color.primary },
  primaryText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  secondaryText: { color: color.primary, fontSize: 16, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  label: { fontSize: 14, fontWeight: "600", color: color.text },
  input: { borderWidth: 1, borderColor: color.border, borderRadius: 8, padding: 12, fontSize: 16, color: color.text },
  error: { color: color.danger, fontSize: 13 },
  card: { borderWidth: 1, borderColor: color.border, borderRadius: 10, padding: 14, gap: 8, backgroundColor: color.bg },
  row: { flexDirection: "row", gap: 8 },
  key: { width: 120, color: color.sub },
  value: { flex: 1, color: color.text },
  choice: { borderWidth: 1, borderColor: color.border, borderRadius: 8, padding: 12 },
  choiceOn: { borderColor: color.primary, backgroundColor: "#ddf4ff" },
});
