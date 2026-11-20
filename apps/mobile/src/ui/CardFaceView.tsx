/**
 * 旧様式の在留カード表面を、IC の券面イメージ(文字部分。白は透明)と顔写真から組み立てて表示する。
 * 背景のデザイン(地紋・ホログラム)は再現しない。項目名はこのアプリで描く
 */
import { useState } from "react";
import { Image, Text, View } from "react-native";
import { LABEL_EN_SIZE, LABEL_SIZE, LEGACY_BANDS, LEGACY_FACE_BOX, LEGACY_FRONT_LABELS } from "@zairyu/shared";
import { color } from "./kit";

export interface ImageData {
  contentType: string;
  data: string;
  width: number;
  height: number;
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%` as const;

export function CardFaceView({ front, face }: { front: ImageData; face?: ImageData | null | undefined }) {
  const [width, setWidth] = useState(0);
  const ratio = front.width > 0 && front.height > 0 ? front.width / front.height : 85.6 / 54;
  return (
    <View style={{ gap: 4 }}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ width: "100%", aspectRatio: ratio, backgroundColor: "#edf5e9", borderRadius: 10, overflow: "hidden", borderWidth: 1, borderColor: color.border }}
      >
        {LEGACY_BANDS.map((b, i) => (
          <View
            key={i}
            style={{ position: "absolute", left: pct(b.x), top: pct(b.y), width: pct(b.width), height: pct(b.height), backgroundColor: "#d7e8f3" }}
          />
        ))}
        {width > 0 &&
          LEGACY_FRONT_LABELS.map((l) => (
            <View key={l.ja} style={{ position: "absolute", left: pct(l.x), top: pct(l.y) }}>
              <Text style={{ fontSize: width * (l.size ?? LABEL_SIZE), color: "#4a5a4a" }}>{l.ja}</Text>
              {l.en && <Text style={{ fontSize: width * LABEL_EN_SIZE, lineHeight: width * LABEL_EN_SIZE * 1.15, color: "#4a5a4a" }}>{l.en}</Text>}
            </View>
          ))}
        {face && (
          <Image
            source={{ uri: `data:${face.contentType};base64,${face.data}` }}
            style={{ position: "absolute", left: pct(LEGACY_FACE_BOX.x), top: pct(LEGACY_FACE_BOX.y), width: pct(LEGACY_FACE_BOX.width), height: pct(LEGACY_FACE_BOX.height) }}
            resizeMode="cover"
          />
        )}
        <Image
          source={{ uri: `data:${front.contentType};base64,${front.data}` }}
          style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%" }}
          resizeMode="stretch"
        />
      </View>
      <Text style={{ color: color.sub, fontSize: 12 }}>IC の記録から組み立てた表示です(地紋などのデザインは省略しています)。</Text>
    </View>
  );
}
