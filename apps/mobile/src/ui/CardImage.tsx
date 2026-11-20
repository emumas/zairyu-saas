/**
 * カード画像の表示。画像はデータ(base64)で受け取り、端末のディスクに保存・キャッシュしない(CLAUDE.md ルール4)
 */
import { Image, Text, View } from "react-native";
import { color } from "./kit";

export const IMAGE_KIND_LABEL: Record<string, string> = {
  front: "撮影した表面",
  back: "撮影した裏面",
  ic_front: "IC の券面イメージ",
  ic_face: "IC の顔写真",
  ic_name: "IC の氏名イメージ",
  ic_address: "IC の住居地イメージ",
};

export function CardImage({ kind, contentType, data, aspectRatio }: { kind: string; contentType: string; data: string; aspectRatio?: number }) {
  const ratio = aspectRatio ?? (kind === "ic_face" ? 0.8 : kind === "ic_name" || kind === "ic_address" ? 2.5 : 85.6 / 54);
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: color.sub, fontSize: 13 }}>{IMAGE_KIND_LABEL[kind] ?? kind}</Text>
      <Image
        source={{ uri: `data:${contentType};base64,${data}` }}
        style={{ width: kind === "ic_face" ? "45%" : "100%", aspectRatio: ratio, borderWidth: 1, borderColor: color.border, backgroundColor: "#fff" }}
        resizeMode="contain"
      />
    </View>
  );
}
